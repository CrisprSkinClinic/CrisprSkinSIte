// netlify/functions/pharmacy-ai-batch-scan.js
//
// Scheduled (see netlify.toml) equivalent of GAS's
// processPendingBillsBatch()/setupAutoPilotCron() -- GAS used
// ScriptApp time-based triggers (every 15 min) to scan a
// "CRISPR_Pending_Bills" Drive inbox folder; Netlify has no
// equivalent trigger mechanism inside a request-scoped function, so
// this runs on Netlify's own scheduled-function support instead
// (same pattern already used by backup-database.js in this repo).
//
// Behavior: scans GOOGLE_DRIVE_PHARMACY_INBOX_FOLDER_ID for PDF/image
// files, runs each through the same Gemini invoice-extraction prompt
// used by extract_invoice_from_image (via pharmacy-ai.js), writes
// each result into pending_approvals for human review (mirrors GAS's
// Pending_Approvals sheet + PENDING status -- nothing is committed to
// real stock automatically, a pharmacist still has to review and
// commit via commit_reviewed_invoice), then moves the processed file
// to GOOGLE_DRIVE_PHARMACY_INVOICES_FOLDER_ID (the same archive
// folder extract_invoice_from_image uploads into) so it isn't
// reprocessed on the next run.
//
// Caps at 3 files per run (matches GAS's processedCount < 3 limit,
// which existed to keep each invocation's runtime bounded -- same
// reasoning applies here under Netlify's function timeout).
//
// This is an OPTIONAL inbox-folder workflow for anyone who prefers
// dropping files into Drive over uploading through the /pharmacy UI
// directly (which uses extract_invoice_from_image synchronously
// instead) -- both paths converge on the same pending_approvals
// table and commit_reviewed_invoice RPC.

const { createClient } = require("@supabase/supabase-js");
const { getDriveAccessToken } = require("./lib/drive-oauth");

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INBOX_FOLDER_ID = process.env.GOOGLE_DRIVE_PHARMACY_INBOX_FOLDER_ID;
const ARCHIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_PHARMACY_INVOICES_FOLDER_ID;

const INVOICE_PROMPT = `
You are an Enterprise Pharmacy AI. Extract the invoice details into this EXACT JSON structure.

CRITICAL INSTRUCTIONS:
1. BATCH GROUPING: If the same product appears multiple times with different batches, group those batches together under the 'batches' array of a single product item. Do NOT create duplicate product items.
2. MEDICAL INFERENCE: Physical invoices often only list the Brand Name. You MUST use your vast medical knowledge to infer and fill in the "molecule_name" (Generic Composition), "category" (Pharmacological Class), "formulation" (e.g., Tablet, Lotion, Syrup), and "strength" if they are not explicitly printed on the bill.

{
  "invoice": { "invoice_number": "string", "invoice_date": "YYYY-MM-DD", "due_date": "YYYY-MM-DD", "irn_number": "string", "place_of_supply": "string", "total_taxable_amount": 0, "total_cgst": 0, "total_sgst": 0, "total_igst": 0, "total_discount": 0, "round_off": 0, "grand_total": 0 },
  "supplier": { "supplier_name": "string", "gstin": "string", "dl_number": "string", "pan": "string", "address": "string", "state_code": "string", "contact_phone": "string", "email": "string", "bank_details": {"bank":"", "account":"", "ifsc":""} },
  "items": [
    {
      "product_name": "string", "molecule_name": "string", "category": "string", "formulation": "string", "strength": "string", "hsn_code": "string", "manufacturer": "string", "pack_size": "string", "gst_percent": 0,
      "batches": [
        { "batch_number": "string", "expiry_date": "YYYY-MM-DD", "qty_purchased": 0, "free_qty": 0, "ptr": 0, "mrp": 0, "discount_percent": 0, "taxable_value": 0, "cgst_percent": 0, "sgst_percent": 0, "igst_percent": 0, "net_purchase_value": 0 }
      ]
    }
  ]
}`;

async function callGeminiForInvoice(accessToken, mimeType, base64Data) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: INVOICE_PROMPT }, { inlineData: { mimeType, data: base64Data } }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Gemini API error: " + (data.error?.message || JSON.stringify(data)));
  let text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no extractable content.");
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(text);
}

async function listInboxFiles(accessToken) {
  const url = `https://www.googleapis.com/drive/v3/files?q='${INBOX_FOLDER_ID}'+in+parents+and+trashed=false&fields=files(id,name,mimeType)&pageSize=5`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json();
  if (!response.ok) throw new Error("Drive list error: " + (data.error?.message || JSON.stringify(data)));
  return data.files || [];
}

async function downloadFile(accessToken, fileId) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Drive download error for file " + fileId);
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

async function moveFile(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${ARCHIVE_FOLDER_ID}&removeParents=${INBOX_FOLDER_ID}`;
  await fetch(url, { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}` } });
}

exports.handler = async () => {
  if (!GEMINI_API_KEY || !INBOX_FOLDER_ID || !ARCHIVE_FOLDER_ID || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.log("pharmacy-ai-batch-scan: missing configuration, skipping this run.");
    return { statusCode: 200, body: "Skipped (not configured)." };
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let processedCount = 0;

  try {
    const accessToken = await getDriveAccessToken();
    const files = await listInboxFiles(accessToken);

    for (const file of files) {
      if (processedCount >= 3) break;
      if (!file.mimeType.includes("pdf") && !file.mimeType.includes("image")) continue;

      try {
        const base64 = await downloadFile(accessToken, file.id);
        const aiResult = await callGeminiForInvoice(accessToken, file.mimeType, base64);

        await moveFile(accessToken, file.id);

        if (!aiResult.invoice) aiResult.invoice = {};
        aiResult.invoice.payment_status = "UNPAID";

        const { error } = await supabase.rpc("create_pending_approval", {
          p_file_name: file.name,
          p_drive_url: `https://drive.google.com/file/d/${file.id}/view`,
          p_ai_data: aiResult,
        });
        if (error) throw error;

        processedCount++;
      } catch (fileError) {
        // One bad file shouldn't stop the rest of the batch --
        // log and move on, matching the GAS version's per-file
        // try/catch-less loop but without letting a single failure
        // crash the whole scheduled run.
        console.error(`pharmacy-ai-batch-scan: failed on file ${file.name}:`, fileError.message);
      }
    }

    console.log(`pharmacy-ai-batch-scan: processed ${processedCount} file(s).`);
    return { statusCode: 200, body: `Processed ${processedCount} file(s).` };
  } catch (error) {
    console.error("pharmacy-ai-batch-scan error:", error);
    return { statusCode: 500, body: error.message };
  }
};

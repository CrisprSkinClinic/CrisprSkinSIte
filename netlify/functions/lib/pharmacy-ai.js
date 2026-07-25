// netlify/functions/lib/pharmacy-ai.js
//
// Ports the GAS "AI ENGINE" module's Gemini-calling functions.
// Reuses lib/drive-upload-helper.js for archival (same OAuth-as-
// real-user Drive connection already used by /prescription), and a
// dedicated GOOGLE_DRIVE_PHARMACY_INVOICES_FOLDER_ID env var (new --
// separate from the lab-reports/photos folders) so invoice/payment
// files land in their own place.
//
// Synchronous / on-demand versions only in this file --
// processInvoiceImage()'s equivalent (extractInvoiceFromImage) is the
// one meant to be called directly from the frontend when a
// pharmacist uploads a single invoice photo right now. The BATCH
// versions (processPendingBillsBatch/processPaymentScreenshotsBatch,
// which in GAS scanned a Drive inbox folder on a timer) are NOT
// ported here -- see netlify/functions/pharmacy-ai-batch-scan.js,
// since Netlify's scheduled-function model doesn't fit inside a
// request-scoped router action.
//
// GEMINI_API_KEY is the one new env var this needs, named to match
// the GAS getGeminiKey() convention directly rather than inventing a
// new name.

const { getDriveAccessToken } = require("./drive-oauth");
const { uploadToDrive } = require("./drive-upload-helper");
const { ok } = require("./supabase-client");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PHARMACY_INVOICES_FOLDER_ID = process.env.GOOGLE_DRIVE_PHARMACY_INVOICES_FOLDER_ID;

function requireGeminiKey() {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured. Set it in Netlify environment variables.");
  }
}

// ---- Shared Gemini caller ----
async function callGemini(prompt, mimeType, base64Data) {
  requireGeminiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const parts = [{ text: prompt }];
  if (mimeType && base64Data) {
    parts.push({ inlineData: { mimeType, data: base64Data } });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error("Gemini API error: " + (data.error?.message || JSON.stringify(data)));
  }

  let text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no extractable content.");
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(text);
}

// ---- Invoice extraction prompt, ported verbatim from
// callGeminiApiForInvoice() ----
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

// ---- extract_invoice_from_image: ports processInvoiceImage() ----
async function extractInvoiceFromImage(data) {
  if (!data?.fileData || !data?.mimeType) {
    return { statusCode: 400, body: JSON.stringify({ error: "fileData (base64) and mimeType are required." }) };
  }
  if (!PHARMACY_INVOICES_FOLDER_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "GOOGLE_DRIVE_PHARMACY_INVOICES_FOLDER_ID is not configured." }) };
  }

  const cleanBase64 = data.fileData.includes(",") ? data.fileData.split(",")[1] : data.fileData;

  const aiResult = await callGemini(INVOICE_PROMPT, data.mimeType, cleanBase64);

  const accessToken = await getDriveAccessToken();
  const fileName = data.fileName || `Invoice_${Date.now()}`;
  const { webViewLink } = await uploadToDrive(accessToken, PHARMACY_INVOICES_FOLDER_ID, fileName, data.mimeType, cleanBase64);

  if (!aiResult.invoice) aiResult.invoice = {};
  aiResult.invoice.bill_url = webViewLink;
  aiResult.invoice.payment_status = "UNPAID";

  return ok({ aiResult });
}

// ---- extract_payment_screenshot: ports the per-file Gemini call
// inside processPaymentScreenshotsBatch(), as a synchronous single-
// file action. Returns the raw extraction only -- the actual
// amount-matching-against-unpaid-invoices logic is a separate,
// explicit step so a human reviews the match before it's applied,
// rather than auto-applying silently like the GAS cron version did.
const PAYMENT_SCREENSHOT_PROMPT = `Extract UPI/Bank payment screenshot details into this strict JSON format: {"amount": 0.00, "utr_number": "string", "payee_name": "string", "date": "YYYY-MM-DD"}`;

async function extractPaymentScreenshot(data) {
  if (!data?.fileData || !data?.mimeType) {
    return { statusCode: 400, body: JSON.stringify({ error: "fileData (base64) and mimeType are required." }) };
  }
  const cleanBase64 = data.fileData.includes(",") ? data.fileData.split(",")[1] : data.fileData;
  const aiResult = await callGemini(PAYMENT_SCREENSHOT_PROMPT, data.mimeType, cleanBase64);
  return ok({ aiResult });
}

// ---- auto_fill_medicine_details: ports autoFillMedicineDetails() ----
async function autoFillMedicineDetails(data) {
  if (!data?.brandName) {
    return { statusCode: 400, body: JSON.stringify({ error: "brandName is required." }) };
  }
  const prompt = `You are a master pharmacist. For the Indian medicine brand name "${data.brandName}", retrieve the exact composition, manufacturer, and tax data. Return ONLY this strict JSON:
    {"generic": "string", "category": "string", "formulation": "string", "company": "string", "strength": "string", "hsn": "string", "gst": 0, "schedule": "string"}`;
  const aiResult = await callGemini(prompt, null, null);
  return ok({ aiResult });
}

// ---- extract_pamphlet_data: ports extractPamphletData() ----
async function extractPamphletData(data) {
  if (!data?.fileData) {
    return { statusCode: 400, body: JSON.stringify({ error: "fileData (base64 image) is required." }) };
  }
  const cleanBase64 = data.fileData.includes(",") ? data.fileData.split(",")[1] : data.fileData;
  const prompt = `Extract product data from this medical pamphlet into strict JSON. {"brand_name": "string", "molecule": "string", "indication": "string", "strength": "string"}`;
  const aiResult = await callGemini(prompt, "image/jpeg", cleanBase64);
  return ok({ aiResult });
}

// ---- get_predictive_reorder: ports getPredictiveReorder(). Uses the
// real get_medicines_with_wac RPC (this project's live stock/reorder
// data) rather than GAS's getMedicines(), same logic otherwise: any
// medicine at or below its reorder_level gets a suggested reorder
// quantity of max(10, 2x reorder level - current stock). ----
async function getPredictiveReorder(supabase) {
  const { data: medicines, error } = await supabase.rpc("get_medicines_with_wac");
  if (error) throw error;

  const recommendations = (medicines || [])
    .filter((m) => Number(m.total_stock) <= Number(m.reorder_level))
    .map((m) => ({
      medicineId: m.medicine_id,
      medName: m.name,
      reason: `Stock (${m.total_stock}) is at or below safety threshold (${m.reorder_level}).`,
      suggestedQty: Math.max(10, m.reorder_level * 2 - m.total_stock),
    }));

  return ok({ recommendations });
}

module.exports = {
  extractInvoiceFromImage,
  extractPaymentScreenshot,
  autoFillMedicineDetails,
  extractPamphletData,
  getPredictiveReorder,
};

// netlify/functions/lib/rx.js
//
// Core prescription actions: boot data, inventory, save, history,
// draft-bill generation. Ported from the old Google Apps Script
// module's getRxInitData/savePrescription/createDraftBill, adapted to
// call the derm_rx_* RPC helpers instead of reading/writing Sheets
// directly. All tables here (derm_rx_*) are fully separate from
// CRIS ClinicOS's own medicines/prescriptions/billing tables in this
// same Supabase project -- see the derm_rx_* table comments for why.

const { ok } = require("./supabase-client");

async function getInitData(supabase) {
  const { data, error } = await supabase.rpc("get_derm_rx_init_data");
  if (error) throw error;
  return ok(data);
}

async function getInventory(supabase) {
  const { data: batches, error } = await supabase.rpc("get_derm_rx_inventory");
  if (error) throw error;
  return ok({ batches });
}

async function getPatientRxHistory(supabase, data) {
  if (!data?.patientId) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("get_patient_rx_history", {
    p_patient_id: data.patientId,
    p_limit: data.limit || 10,
  });
  if (error) throw error;
  return ok({ prescriptions: rows });
}

async function getRxById(supabase, data) {
  if (!data?.rxId) {
    return { statusCode: 400, body: JSON.stringify({ error: "rxId is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("get_derm_rx_by_id", { p_rx_id: data.rxId });
  if (error) throw error;
  if (!rows || rows.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: "Prescription not found." }) };
  }
  return ok(rows[0]);
}

// --- Quantity calculation, ported from the old getPrescriptionData()
// client-side helper and createDraftBill()'s server-side duplicate of
// the same logic. Done once here so both the saved prescription and
// the draft bill agree on quantities. ---
function calculateOralQty(dose, duration) {
  const d = String(dose || "").toLowerCase().trim();
  const dur = String(duration || "").toLowerCase().trim();

  let dailyQty = 0;
  const pattern = /^(\d+(?:[.\/]\d+)?)\s*-\s*(\d+(?:[.\/]\d+)?)\s*-\s*(\d+(?:[.\/]\d+)?)(?:\s*-\s*(\d+(?:[.\/]\d+)?))?/;
  const match = d.match(pattern);
  const parsePart = (p) => {
    if (!p) return 0;
    if (p.includes("/")) {
      const [n, den] = p.split("/");
      return parseFloat(n) / parseFloat(den);
    }
    return parseFloat(p) || 0;
  };

  if (match) {
    dailyQty = parsePart(match[1]) + parsePart(match[2]) + parsePart(match[3]) + parsePart(match[4]);
  } else if (d.includes("twice") || d.includes("bd")) dailyQty = 2;
  else if (d.includes("thrice") || d.includes("tds")) dailyQty = 3;
  else if (d.includes("once") || d.includes("daily") || d.includes("od")) dailyQty = 1;
  else dailyQty = 1;

  let days = parseFloat(dur) || 1;
  if (dur.includes("week")) days = days * 7;
  if (dur.includes("month")) days = days * 30;

  return Math.max(1, Math.ceil(dailyQty * days));
}

function calculateTopicalQty(duration) {
  const dur = String(duration || "").toLowerCase().trim();
  let months = 1;
  if (dur.includes("month")) months = parseFloat(dur) || 1;
  else if (dur.includes("week")) months = Math.ceil((parseFloat(dur) || 1) / 4);
  return Math.max(1, months);
}

function isTopical(dose) {
  const d = String(dose || "").toLowerCase();
  return d.includes("apply") || d.includes("tube") || d.includes("jar") || d.includes("cream") || d.includes("gel");
}

function enrichMedicinesWithQty(medicines) {
  return (medicines || []).map((m) => ({
    ...m,
    qty: isTopical(m.dose) ? calculateTopicalQty(m.duration) : calculateOralQty(m.dose, m.duration),
  }));
}

async function savePrescription(supabase, data, profile) {
  if (!data?.patientId || !data?.doctorId) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId and doctorId are required." }) };
  }

  const enrichedMeds = enrichMedicinesWithQty(data.medicines);

  const { data: rxId, error } = await supabase.rpc("save_derm_rx_prescription", {
    p_patient_id: data.patientId,
    p_doctor_id: data.doctorId,
    p_appointment_id: data.appointmentId || null,
    p_status: data.status === "draft" ? "draft" : "final",
    p_complaints: data.complaints || null,
    p_diagnosis: data.diagnosis || null,
    p_differentials: data.differentials || [],
    p_medicines: enrichedMeds,
    p_lab_tests: data.labTests || [],
    p_advice: data.advice || null,
    p_review_date: data.reviewDate || null,
    p_vitals: data.vitals || null,
  });
  if (error) throw error;

  // Draft bill generation only happens for a FINAL prescription, not a
  // draft-in-progress save -- matches the old system only ever
  // calling createDraftBill() from within the real save path, never
  // from the autosave/draft path.
  let draftBillId = null;
  if (data.status !== "draft") {
    draftBillId = await generateDraftBill(supabase, data.patientId, rxId, enrichedMeds, data.labTests || []);
  }

  return ok({ success: true, rxId, draftBillId });
}

// FIFO batch matching for pharmacy items + billing-master lookup for
// lab/service items, ported from the old createDraftBill(). Returns
// the draft bill id, or null if there was nothing to bill (e.g. an
// all-free consultation with no meds/labs).
async function generateDraftBill(supabase, patientId, rxId, enrichedMeds, labTests) {
  const { data: batches, error: invError } = await supabase.rpc("get_derm_rx_inventory");
  if (invError) throw invError;
  // get_derm_rx_inventory already orders by expiry_date asc (FIFO) --
  // no need to re-sort here, unlike the old JS which sorted client-side.

  const pharmItems = [];
  for (const med of enrichedMeds) {
    const medNameClean = String(med.name || "").trim().toLowerCase();
    const batch = (batches || []).find((b) => String(b.medicine_name).trim().toLowerCase() === medNameClean && b.stock > 0);

    if (batch) {
      pharmItems.push({
        batchId: batch.id,
        name: batch.medicine_name,
        mrp: batch.mrp,
        qty: med.qty,
        stock: batch.stock,
        batchNo: batch.batch_no,
        expiry: batch.expiry_date,
        hsn: batch.hsn_code,
        gst: batch.gst_rate,
        disc: 0,
        manual: false,
      });
    } else {
      pharmItems.push({
        batchId: "MANUAL",
        name: med.name,
        mrp: 0,
        qty: med.qty,
        stock: 0,
        batchNo: "-",
        expiry: "",
        hsn: "",
        gst: 0,
        disc: 0,
        manual: true,
      });
    }
  }

  const serviceItems = [];
  if (labTests && labTests.length > 0) {
    const { data: billingRows } = await supabase
      .from("derm_rx_billing_master")
      .select("id, service_type, name, price, gst_rate")
      .in(
        "name",
        labTests.map((t) => t)
      );
    for (const testName of labTests) {
      const rate = (billingRows || []).find((r) => r.name.trim().toLowerCase() === testName.trim().toLowerCase());
      if (rate) {
        serviceItems.push({ id: rate.id, type: rate.service_type, name: rate.name, price: rate.price, gstRate: rate.gst_rate, gstEnabled: rate.gst_rate > 0 });
      } else {
        serviceItems.push({ id: "MANUAL_LAB", type: "Lab", name: testName, price: 0, gstRate: 0, gstEnabled: false });
      }
    }
  }

  if (pharmItems.length === 0 && serviceItems.length === 0) return null;

  const { data: draftBillId, error } = await supabase.rpc("upsert_derm_rx_draft_bill", {
    p_patient_id: patientId,
    p_prescription_id: rxId,
    p_pharmacy_items: pharmItems,
    p_service_items: serviceItems,
  });
  if (error) throw error;
  return draftBillId;
}

async function updatePrescriptionPdf(supabase, data) {
  if (!data?.rxId || !data?.pdfUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: "rxId and pdfUrl are required." }) };
  }
  const { error } = await supabase.rpc("update_derm_rx_prescription_pdf", { p_rx_id: data.rxId, p_pdf_url: data.pdfUrl });
  if (error) throw error;
  return ok({ success: true });
}

module.exports = {
  getInitData,
  getInventory,
  getPatientRxHistory,
  getRxById,
  savePrescription,
  updatePrescriptionPdf,
};

// netlify/functions/lib/pharmacy.js
//
// Backend logic for the /pharmacy tool -- wires the Postgres RPCs
// built for the pharmacy module onto CRIS ClinicOS's EXISTING
// suppliers/medicines/medicine_batches/purchase_orders/
// pharmacy_dispenses/bills schema (a deliberate reversal of the
// derm_rx_* "keep fully separate" approach -- this schema already
// existed, unused, and was a good structural match for the ported
// GAS "CRISPR Pharmacy OS" logic, so it was extended in place rather
// than duplicated).
//
// Ported from GAS: executeStockOut -> executePharmacySale,
// voidEntireSale -> voidPharmacySale, processPartialReturn ->
// returnPharmacySaleItems. Stock adjustment itself is NOT done here
// or in the RPCs directly -- a pre-existing trigger
// (dispense_item_stock_decrement on pharmacy_dispense_items) already
// adjusts medicine_batches.quantity_remaining on every item insert,
// including negative quantities for void/return rows. The RPCs only
// lock+verify sufficient stock before inserting.

const { ok } = require("./supabase-client");

// ---- Whoami (frontend needs full_name + role to show who's signed
// in and whether to expose pharmacist-vs-doctor-only affordances --
// no doctors.id lookup needed here, unlike prescription-manager.js's
// whoami, since a pharmacist has no row in the doctors table at all) ----
async function whoami(profile) {
  return ok({ profile: { id: profile.id, full_name: profile.full_name, role: profile.role } });
}

// ---- Suppliers ----
async function listSuppliers(supabase) {
  const { data, error } = await supabase.rpc("list_suppliers");
  if (error) throw error;
  return ok({ suppliers: data });
}

async function upsertSupplier(supabase, data) {
  if (!data?.name) {
    return { statusCode: 400, body: JSON.stringify({ error: "Supplier name is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_supplier", {
    p_id: data.id || null,
    p_name: data.name.trim(),
    p_contact_person: data.contactPerson || null,
    p_gstin: data.gstin || null,
    p_phone: data.phone || null,
    p_email: data.email || null,
    p_address: data.address || null,
    p_city: data.city || null,
    p_state: data.state || null,
    p_credit_days: data.creditDays ?? 0,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function deactivateSupplier(supabase, data) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("deactivate_supplier", { p_id: data.id });
  if (error) throw error;
  return ok({ success: true });
}

// ---- Medicines ----
async function listMedicines(supabase) {
  const { data, error } = await supabase.rpc("list_medicines");
  if (error) throw error;
  return ok({ medicines: data });
}

async function upsertMedicine(supabase, data) {
  if (!data?.name) {
    return { statusCode: 400, body: JSON.stringify({ error: "Medicine name is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_medicine", {
    p_id: data.id || null,
    p_name: data.name.trim(),
    p_generic_name: data.genericName || null,
    p_category: data.category || null,
    p_formulation: data.formulation || "tablet",
    p_unit: data.unit || "strip",
    p_reorder_level: data.reorderLevel ?? 10,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function deactivateMedicine(supabase, data) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("deactivate_medicine", { p_id: data.id });
  if (error) throw error;
  return ok({ success: true });
}

// ---- Inventory views ----
async function getInventory(supabase) {
  const { data, error } = await supabase.rpc("get_pharmacy_inventory");
  if (error) throw error;
  return ok({ inventory: data });
}

async function getLowStock(supabase) {
  const { data, error } = await supabase.rpc("get_low_stock_medicines");
  if (error) throw error;
  return ok({ lowStock: data });
}

async function getExpiringBatches(supabase, data) {
  const { data: rows, error } = await supabase.rpc("get_expiring_batches", {
    p_within_days: data?.withinDays ?? 90,
  });
  if (error) throw error;
  return ok({ expiringBatches: rows });
}

async function getFifoBatches(supabase, data) {
  if (!data?.medicineId || !data?.quantity) {
    return { statusCode: 400, body: JSON.stringify({ error: "medicineId and quantity are required." }) };
  }
  // Pre-existing RPC, not written this phase -- read-only helper for
  // the checkout UI to suggest which batch(es) to sell from.
  const { data: rows, error } = await supabase.rpc("get_fifo_batches", {
    p_medicine_id: data.medicineId,
    p_quantity: data.quantity,
  });
  if (error) throw error;
  return ok({ batches: rows });
}

// ---- Purchase orders ----
async function createPurchaseOrder(supabase, data) {
  if (!data?.supplierId || !Array.isArray(data?.items) || data.items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "supplierId and at least one item are required." }) };
  }
  const { data: id, error } = await supabase.rpc("create_purchase_order", {
    p_supplier_id: data.supplierId,
    p_items: data.items,
    p_invoice_number: data.invoiceNumber || null,
    p_invoice_date: data.invoiceDate || null,
    p_notes: data.notes || null,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function receivePurchaseOrder(supabase, data, profile) {
  if (!data?.poId) {
    return { statusCode: 400, body: JSON.stringify({ error: "poId is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("receive_purchase_order", {
    p_po_id: data.poId,
    p_received_by: profile.id,
    p_payment_mode: data.paymentMode || null,
    p_amount_paid: data.amountPaid ?? 0,
  });
  if (error) throw error;
  return ok({ success: true, ...rows[0] });
}

async function listPurchaseOrders(supabase, data) {
  const { data: rows, error } = await supabase.rpc("list_purchase_orders", {
    p_status: data?.status || null,
  });
  if (error) throw error;
  return ok({ purchaseOrders: rows });
}

// ---- Sale / void / partial return ----
async function executePharmacySale(supabase, data, profile) {
  if (!Array.isArray(data?.items) || data.items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "At least one line item is required." }) };
  }
  if (!data.patientId && !data.newPatientName) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId or newPatientName is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("execute_pharmacy_sale", {
    p_items: data.items,
    p_dispensed_by: profile.id,
    p_patient_id: data.patientId || null,
    p_new_patient_name: data.newPatientName || null,
    p_new_patient_phone: data.newPatientPhone || null,
    p_prescription_id: data.prescriptionId || null,
    p_payment_mode: data.paymentMode || "cash",
    p_appointment_id: data.appointmentId || null,
    p_notes: data.notes || null,
  });
  if (error) throw error;
  return ok({ success: true, ...rows[0] });
}

async function voidPharmacySale(supabase, data, profile) {
  if (!data?.originalDispenseId) {
    return { statusCode: 400, body: JSON.stringify({ error: "originalDispenseId is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("void_pharmacy_sale", {
    p_original_dispense_id: data.originalDispenseId,
    p_dispensed_by: profile.id,
    p_reason: data.reason || null,
  });
  if (error) throw error;
  return ok({ success: true, ...rows[0] });
}

async function getTodaysPharmacySummary(supabase) {
  const { data: rows, error } = await supabase.rpc("get_todays_pharmacy_summary");
  if (error) throw error;
  return ok({ summary: rows[0] });
}

async function getDispenseItems(supabase, data) {
  if (!data?.dispenseId) {
    return { statusCode: 400, body: JSON.stringify({ error: "dispenseId is required." }) };
  }
  const { data: items, error } = await supabase.rpc("get_dispense_items", { p_dispense_id: data.dispenseId });
  if (error) throw error;
  return ok({ items });
}

async function returnPharmacySaleItems(supabase, data, profile) {
  if (!data?.originalDispenseId || !Array.isArray(data?.returnItems) || data.returnItems.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "originalDispenseId and at least one return item are required." }) };
  }
  const { data: rows, error } = await supabase.rpc("return_pharmacy_sale_items", {
    p_original_dispense_id: data.originalDispenseId,
    p_return_items: data.returnItems,
    p_dispensed_by: profile.id,
    p_reason: data.reason || null,
  });
  if (error) throw error;
  return ok({ success: true, ...rows[0] });
}

// ==========================================================
// PHASE 2: WAC inventory, full CRUD (extra fields), physical
// audit, pending approvals, medical reps, vendor merge, and the
// AI-invoice-review commit path. Additive to everything above --
// none of the Phase 1 functions/actions change.
// ==========================================================

async function getMedicinesWithWac(supabase) {
  const { data, error } = await supabase.rpc("get_medicines_with_wac");
  if (error) throw error;
  return ok({ medicines: data });
}

async function upsertMedicineFull(supabase, data) {
  if (!data?.name) {
    return { statusCode: 400, body: JSON.stringify({ error: "Medicine name is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_medicine_full", {
    p_id: data.id || null,
    p_name: data.name.trim(),
    p_generic_name: data.genericName || null,
    p_category: data.category || null,
    p_manufacturer: data.manufacturer || null,
    p_formulation: data.formulation || "tablet",
    p_unit: data.unit || "strip",
    p_reorder_level: data.reorderLevel ?? 10,
    p_hsn_code: data.hsnCode || null,
    p_gst_percent: data.gstPercent ?? 0,
    p_preferred_supplier_id: data.preferredSupplierId || null,
    p_rep_name: data.repName || null,
    p_rep_phone: data.repPhone || null,
    p_scheme_buy: data.schemeBuy ?? 0,
    p_scheme_free: data.schemeFree ?? 0,
    p_brand_discount: data.brandDiscount ?? 0,
    p_discount_type: data.discountType || "PTR",
    p_drug_schedule: data.drugSchedule || "NONE",
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function upsertSupplierFull(supabase, data) {
  if (!data?.name) {
    return { statusCode: 400, body: JSON.stringify({ error: "Supplier name is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_supplier_full", {
    p_id: data.id || null,
    p_name: data.name.trim(),
    p_contact_person: data.contactPerson || null,
    p_gstin: data.gstin || null,
    p_dl_number: data.dlNumber || null,
    p_phone: data.phone || null,
    p_email: data.email || null,
    p_address: data.address || null,
    p_city: data.city || null,
    p_state: data.state || null,
    p_credit_days: data.creditDays ?? 0,
    p_bank_name: data.bankName || null,
    p_bank_account: data.bankAccount || null,
    p_bank_ifsc: data.bankIfsc || null,
    p_upi_id: data.upiId || null,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function manualStockAdjustment(supabase, data, profile) {
  if (!data?.medicineId || !data?.quantity || !data?.type) {
    return { statusCode: 400, body: JSON.stringify({ error: "medicineId, quantity, and type are required." }) };
  }
  const { data: batchId, error } = await supabase.rpc("manual_stock_adjustment", {
    p_medicine_id: data.medicineId,
    p_quantity: data.quantity,
    p_type: data.type,
    p_reason: data.reason || null,
    p_adjusted_by: profile.id,
  });
  if (error) throw error;
  return ok({ success: true, batchId });
}

async function runPhysicalAudit(supabase, data, profile) {
  if (!Array.isArray(data?.audits) || data.audits.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "At least one audit line is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("run_physical_audit", {
    p_audits: data.audits,
    p_audited_by: profile.id,
    p_reason: data.reason || null,
  });
  if (error) throw error;
  return ok({ results: rows });
}

async function listPendingApprovals(supabase) {
  const { data, error } = await supabase.rpc("list_pending_approvals");
  if (error) throw error;
  return ok({ pendingApprovals: data });
}

async function createPendingApproval(supabase, data) {
  if (!data?.fileName || !data?.aiData) {
    return { statusCode: 400, body: JSON.stringify({ error: "fileName and aiData are required." }) };
  }
  const { data: id, error } = await supabase.rpc("create_pending_approval", {
    p_file_name: data.fileName,
    p_drive_url: data.driveUrl || null,
    p_ai_data: data.aiData,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function rejectPendingApproval(supabase, data, profile) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("reject_pending_approval", { p_id: data.id, p_reviewed_by: profile.id });
  if (error) throw error;
  return ok({ success: true });
}

async function listMedicalReps(supabase) {
  const { data, error } = await supabase.rpc("list_medical_reps");
  if (error) throw error;
  return ok({ reps: data });
}

async function upsertMedicalRep(supabase, data) {
  if (!data?.repName) {
    return { statusCode: 400, body: JSON.stringify({ error: "repName is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_medical_rep", {
    p_id: data.id || null,
    p_rep_name: data.repName.trim(),
    p_company: data.company || null,
    p_division: data.division || null,
    p_phone: data.phone || null,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function deactivateMedicalRep(supabase, data) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("deactivate_medical_rep", { p_id: data.id });
  if (error) throw error;
  return ok({ success: true });
}

async function mergeDuplicateSuppliers(supabase, data) {
  if (!data?.duplicateId || !data?.masterId) {
    return { statusCode: 400, body: JSON.stringify({ error: "duplicateId and masterId are required." }) };
  }
  const { error } = await supabase.rpc("merge_duplicate_suppliers", {
    p_duplicate_id: data.duplicateId,
    p_master_id: data.masterId,
  });
  if (error) throw error;
  return ok({ success: true });
}

async function commitReviewedInvoice(supabase, data) {
  if (!data?.supplier || !data?.invoice) {
    return { statusCode: 400, body: JSON.stringify({ error: "supplier and invoice are required." }) };
  }
  const { data: rows, error } = await supabase.rpc("commit_reviewed_invoice", { p_data: data });
  if (error) throw error;
  return ok({ success: true, ...rows[0] });
}

module.exports = {
  whoami,
  listSuppliers,
  upsertSupplier,
  deactivateSupplier,
  listMedicines,
  upsertMedicine,
  deactivateMedicine,
  getInventory,
  getLowStock,
  getExpiringBatches,
  getFifoBatches,
  createPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  executePharmacySale,
  voidPharmacySale,
  returnPharmacySaleItems,
  getDispenseItems,
  getTodaysPharmacySummary,
  getMedicinesWithWac,
  upsertMedicineFull,
  upsertSupplierFull,
  manualStockAdjustment,
  runPhysicalAudit,
  listPendingApprovals,
  createPendingApproval,
  rejectPendingApproval,
  listMedicalReps,
  upsertMedicalRep,
  deactivateMedicalRep,
  mergeDuplicateSuppliers,
  commitReviewedInvoice,
};

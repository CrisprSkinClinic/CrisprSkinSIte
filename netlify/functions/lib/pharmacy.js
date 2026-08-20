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

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

// ---- Patient search/lookup, added to close the gap where the
// pharmacy checkout previously had NO way to find an existing,
// already-registered patient -- every sale silently created a new
// `patients` row via p_new_patient_name/p_new_patient_phone, even for
// someone who already had a UHID. This forwards the CALLER'S OWN
// access token (not the service-role key) to the `patients` Supabase
// Edge Function, because that function authenticates by calling
// userClient.auth.getUser() on whatever's in the Authorization header
// -- it needs a real staff JWT with a `profiles` row so
// current_user_role() resolves, not the service-role key itself.
// Confirmed live: `patients` edge function is deployed and ACTIVE on
// this same Supabase project, so no new backend function is required,
// only this new call site. ----
async function callPatientsFunction(accessToken, action, payload = {}) {
  if (!SUPABASE_URL) {
    throw new Error("APPOINTMENT_MANAGER_SUPABASE_URL is not configured.");
  }
  const res = await fetch(`${SUPABASE_URL}/functions/v1/patients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await res.json();
  if (!res.ok || result.error) {
    throw new Error(result.error || "Patient lookup failed.");
  }
  return result.data ?? result;
}

async function searchPatients(accessToken, data) {
  if (!data?.query || data.query.trim().length < 2) {
    return ok({ patients: [] });
  }
  const patients = await callPatientsFunction(accessToken, "search", { query: data.query.trim() });
  return ok({ patients: patients ?? [] });
}

// ---- Prescription-linked dispense queue (new tab: "Rx Queue"),
// added alongside checkout because ClinicOS's own PharmacyQueuePage
// pattern was the missing UX piece here, and it turned out to have a
// live bug (querying patients.name directly, which doesn't exist) --
// see get_pharmacy_dispense_queue's migration comment. Only reads,
// via a new dedicated RPC, no schema risk. ----
// Looks up one patient by id (used when loading a prescription into
// the cart from the Rx Queue tab, so the correct patient is
// pre-selected rather than left as an unlinked walk-in). Uses the
// `patients` edge function's get_by_ids action, which is the only
// existing action that can fetch decrypted PII by id -- confirmed by
// reading supabase/functions/patients/index.ts directly rather than
// assuming an action existed.
async function getPatientById(accessToken, data) {
  if (!data?.patientId) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId is required." }) };
  }
  const patients = await callPatientsFunction(accessToken, "get_by_ids", { patientIds: [data.patientId] });
  return ok({ patient: (patients && patients[0]) || null });
}

async function getDispenseQueue(supabase) {
  const { data, error } = await supabase.rpc("get_pharmacy_dispense_queue");
  if (error) throw error;
  return ok({ queue: data ?? [] });
}

async function getPrescriptionForDispense(supabase, data) {
  if (!data?.prescriptionId) {
    return { statusCode: 400, body: JSON.stringify({ error: "prescriptionId is required." }) };
  }
  const { data: items, error } = await supabase
    .from("prescription_items")
    .select("*")
    .eq("prescription_id", data.prescriptionId)
    .is("deleted_at", null)
    .order("sort_order");
  if (error) throw error;
  return ok({ items: items ?? [] });
}

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
// ---- Vendor Ledger (new — matches ClinicOS's useVendorLedger.js /
// VendorLedgerSheet.jsx: a per-supplier view of outstanding POs with
// bulk mark-paid, reusing record_po_payment for the actual payment
// writes rather than duplicating its balance/journal logic). ----
async function getSupplierOutstandingPOs(supabase, data) {
  if (!data?.supplierId) {
    return { statusCode: 400, body: JSON.stringify({ error: "supplierId is required." }) };
  }
  const { data: rows, error } = await supabase
    .from("purchase_orders")
    .select("id, po_number, invoice_number, invoice_date, total_amount, amount_paid, balance_due, payment_status, due_date")
    .eq("supplier_id", data.supplierId)
    .in("payment_status", ["pending", "partial"])
    .order("due_date", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return ok({ purchaseOrders: rows ?? [] });
}

// Marks a set of POs paid via record_po_payment, one call per PO
// (incremental amount = balance_due), same approach as ClinicOS's
// useBulkMarkPaid -- record_po_payment already rejects any amount
// that would exceed the outstanding balance, so this is safe even if
// a PO in the batch already has a partial payment on it.
async function bulkMarkPosPaid(supabase, data, profile) {
  if (!Array.isArray(data?.purchaseOrders) || data.purchaseOrders.length === 0 || !data?.paymentMode) {
    return { statusCode: 400, body: JSON.stringify({ error: "purchaseOrders (array) and paymentMode are required." }) };
  }
  const paidIds = [];
  for (const po of data.purchaseOrders) {
    const remaining = Number(po.total_amount) - Number(po.amount_paid || 0);
    if (remaining <= 0) continue;
    const { error } = await supabase.rpc("record_po_payment", {
      p_po_id: po.id,
      p_amount: remaining,
      p_payment_mode: data.paymentMode,
      p_paid_by: profile.id,
    });
    if (error) throw new Error(`Failed to mark ${po.po_number} as paid: ${error.message}`);
    paidIds.push(po.id);
  }
  return ok({ success: true, paidIds });
}

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

// ---- Quick Stock entry — direct medicine_batches insert, matching
// ClinicOS's StockEntryForm.jsx exactly (same fields, same defaults).
// Deliberately separate from the purchase-order flow: no supplier_id
// link (just a free-text `supplier` string, confirmed live via
// information_schema.columns), no invoice/GST fields set, and
// effective_cost_per_unit is left null -- execute_pharmacy_sale's COGS
// calc already falls back to purchase_price via coalesce() for
// exactly this case, so this doesn't break costing, just leaves WAC
// slightly less precise for quick-stocked batches than PO-received
// ones. ----
async function quickAddStock(supabase, data, profile) {
  if (!data?.medicineId || !data?.expiryDate || !data?.quantityReceived || data?.sellingPrice == null) {
    return { statusCode: 400, body: JSON.stringify({ error: "medicineId, expiryDate, quantityReceived, and sellingPrice are required." }) };
  }
  const qty = Number(data.quantityReceived);
  if (!Number.isFinite(qty) || qty < 1) {
    return { statusCode: 400, body: JSON.stringify({ error: "quantityReceived must be at least 1." }) };
  }
  const { data: batch, error } = await supabase
    .from("medicine_batches")
    .insert({
      medicine_id: data.medicineId,
      batch_number: data.batchNumber?.trim() || null,
      expiry_date: data.expiryDate,
      purchase_price: Number(data.purchasePrice) || 0,
      selling_price: Number(data.sellingPrice),
      quantity_received: qty,
      quantity_remaining: qty,
      supplier: data.supplier?.trim() || null,
      received_by: profile.id,
    })
    .select("id")
    .single();
  if (error) throw error;
  return ok({ success: true, batchId: batch.id });
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

// ---- Record a payment against an already-received PO (new — closes
// a real gap: this RPC existed live and was already called from
// ClinicOS's useVendorLedger.js, but had NO caller anywhere in this
// codebase, so a partial/pending PO had no follow-up payment path
// once received. ----
async function recordPoPayment(supabase, data, profile) {
  if (!data?.poId || !data?.amount || !data?.paymentMode) {
    return { statusCode: 400, body: JSON.stringify({ error: "poId, amount, and paymentMode are required." }) };
  }
  const { data: rows, error } = await supabase.rpc("record_po_payment", {
    p_po_id: data.poId,
    p_amount: Number(data.amount),
    p_payment_mode: data.paymentMode,
    p_paid_by: profile.id,
  });
  if (error) throw error;
  return ok({ success: true, ...rows[0] });
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
    // FIX: this argument was previously omitted entirely from this
    // call. The RPC defaults it to NULL, so nothing errored, but every
    // dispense_item row created via this action had no
    // prescription_item_id -- prescription fulfillment could never be
    // tracked for a sale made through this UI. Must be parallel to
    // p_items (same order, one entry per line item; null for lines
    // with no source prescription item, e.g. POS/walk-in sales).
    p_prescription_item_ids: data.prescriptionItemIds || null,
    p_appointment_id: data.appointmentId || null,
    p_payment_mode: data.paymentMode || "cash",
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
  // NOTE: manual_stock_adjustment's return shape changed (was a bare
  // uuid, now TABLE(batch_id, quantity_adjusted)) as part of fixing a
  // real bug where any non-'PURCHASE' adjustment silently removed
  // zero stock regardless of requested quantity -- see the migration
  // comment. supabase.rpc() on a TABLE-returning function returns an
  // array of rows, so this reads rows[0] rather than the old bare
  // scalar.
  const { data: rows, error } = await supabase.rpc("manual_stock_adjustment", {
    p_medicine_id: data.medicineId,
    p_quantity: data.quantity,
    p_type: data.type,
    p_reason: data.reason || null,
    p_adjusted_by: profile.id,
  });
  if (error) throw error;
  const result = rows?.[0] || {};
  return ok({ success: true, batchId: result.batch_id, quantityAdjusted: result.quantity_adjusted });
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

// FIXED: this previously called upsert_medical_rep with p_rep_name,
// which does not exist as a parameter on the live function -- the
// real signature is p_salutation/p_first_name/p_last_name (confirmed
// via pg_get_function_arguments), so every "New Medical Rep" save in
// the live pharmacy tool has been throwing "function ... does not
// exist" the whole time. list_medical_reps also has no rep_name
// column (only first_name/last_name/salutation), so the existing rep
// list has also been rendering blank names. Both fixed here together,
// and the fuller ClinicOS field set (designation, offer/discount,
// preferred suppliers, delivery days) is exposed too since the RPC
// already supports all of it.
async function upsertMedicalRep(supabase, data) {
  if (!data?.firstName && !data?.lastName) {
    return { statusCode: 400, body: JSON.stringify({ error: "At least a first or last name is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_medical_rep", {
    p_id: data.id || null,
    p_salutation: data.salutation || null,
    p_first_name: data.firstName || null,
    p_last_name: data.lastName || null,
    p_company: data.company || null,
    p_division: data.division || null,
    p_phone: data.phone || null,
    p_email: data.email || null,
    p_designation: data.designation || null,
    p_offer_type: data.offerType || null,
    p_offer_free_details: data.offerFreeDetails || null,
    p_offer_discount_percent: data.offerDiscountPercent ?? null,
    p_preferred_supplier_1_id: data.preferredSupplier1Id || null,
    p_preferred_supplier_1_other: data.preferredSupplier1Other || null,
    p_preferred_supplier_2_id: data.preferredSupplier2Id || null,
    p_preferred_supplier_2_other: data.preferredSupplier2Other || null,
    p_delivery_days: data.deliveryDays ?? null,
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
  searchPatients,
  getPatientById,
  getDispenseQueue,
  getPrescriptionForDispense,
  getSupplierOutstandingPOs,
  bulkMarkPosPaid,
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
  recordPoPayment,
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

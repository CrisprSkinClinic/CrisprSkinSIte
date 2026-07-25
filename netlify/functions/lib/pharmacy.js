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
};

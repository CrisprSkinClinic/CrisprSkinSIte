// netlify/functions/pharmacy-manager.js
//
// Backend for the standalone /pharmacy tool. Same authentication model
// as bookings-manager.js and prescription-manager.js -- real Supabase
// Auth JWT verified per request (verifyStaffAuth), so every sale/void/
// return/PO action is attributed to the actual logged-in staff member.
// Reuses the shared lib/ (supabase-client.js, auth.js, audit.js).
//
// Unlike prescription-manager.js (doctor-only), pharmacy actions are
// usable by EITHER a pharmacist or a doctor -- a doctor may need to
// dispense directly (e.g. a small clinic without a dedicated
// pharmacist on every shift), matching how the GAS "CRISPR Pharmacy
// OS" was used in practice.
//
// Pharmacy data lives in CRIS ClinicOS's existing suppliers/medicines/
// medicine_batches/purchase_orders/pharmacy_dispenses/bills tables --
// a deliberate exception to the "keep fully separate from ClinicOS"
// rule used for derm_rx_*, made because this schema already existed,
// unused, and was a strong structural match for the ported GAS logic.

const { createServiceRoleClient, ok } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");
const { makeLogAudit } = require("./lib/audit");

const pharmacy = require("./lib/pharmacy");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { supabase, errorResponse: clientError } = createServiceRoleClient();
  if (clientError) return clientError;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { accessToken, action, data } = payload;

  const { profile, errorResponse: authError } = await verifyStaffAuth(supabase, accessToken);
  if (authError) return authError;
  if (!["doctor", "pharmacist"].includes(profile.role)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Only doctor or pharmacist accounts can access the pharmacy system." }) };
  }

  const logAudit = makeLogAudit(supabase, profile);

  try {
    switch (action) {
      case "whoami":
        return await pharmacy.whoami(profile);

      // ---- Suppliers ----
      case "list_suppliers":
        return await pharmacy.listSuppliers(supabase);
      case "upsert_supplier": {
        const result = await pharmacy.upsertSupplier(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_SUPPLIER_SAVE", `Saved supplier ${data?.name || ""}`);
        return result;
      }
      case "deactivate_supplier": {
        const result = await pharmacy.deactivateSupplier(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_SUPPLIER_DEACTIVATE", `Deactivated supplier ${data?.id || ""}`);
        return result;
      }

      // ---- Medicines ----
      case "list_medicines":
        return await pharmacy.listMedicines(supabase);
      case "upsert_medicine": {
        const result = await pharmacy.upsertMedicine(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_MEDICINE_SAVE", `Saved medicine ${data?.name || ""}`);
        return result;
      }
      case "deactivate_medicine": {
        const result = await pharmacy.deactivateMedicine(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_MEDICINE_DEACTIVATE", `Deactivated medicine ${data?.id || ""}`);
        return result;
      }

      // ---- Inventory views ----
      case "get_inventory":
        return await pharmacy.getInventory(supabase);
      case "get_low_stock":
        return await pharmacy.getLowStock(supabase);
      case "get_expiring_batches":
        return await pharmacy.getExpiringBatches(supabase, data);
      case "get_fifo_batches":
        return await pharmacy.getFifoBatches(supabase, data);

      // ---- Purchase orders ----
      case "create_purchase_order": {
        const result = await pharmacy.createPurchaseOrder(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_PO_CREATE", `Created purchase order for supplier ${data?.supplierId || ""}`);
        return result;
      }
      case "receive_purchase_order": {
        const result = await pharmacy.receivePurchaseOrder(supabase, data, profile);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_PO_RECEIVE", `Received purchase order ${data?.poId || ""}`);
        return result;
      }
      case "list_purchase_orders":
        return await pharmacy.listPurchaseOrders(supabase, data);

      // ---- Sale / void / partial return ----
      case "execute_pharmacy_sale": {
        const result = await pharmacy.executePharmacySale(supabase, data, profile);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_SALE", `Dispensed sale for patient ${data?.patientId || data?.newPatientName || "walk-in"}`);
        return result;
      }
      case "void_pharmacy_sale": {
        const result = await pharmacy.voidPharmacySale(supabase, data, profile);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_VOID", `Voided dispense ${data?.originalDispenseId || ""}: ${data?.reason || "no reason given"}`);
        return result;
      }
      case "return_pharmacy_sale_items": {
        const result = await pharmacy.returnPharmacySaleItems(supabase, data, profile);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("PHARMACY_PARTIAL_RETURN", `Partial return on dispense ${data?.originalDispenseId || ""}: ${data?.reason || "no reason given"}`);
        return result;
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }
  } catch (error) {
    console.error("pharmacy-manager error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Internal server error" }) };
  }
};

// netlify/functions/prescription-manager.js
//
// Backend for the standalone /prescription tool. Same authentication
// model as bookings-manager.js -- real Supabase Auth JWT verified per
// request (verifyStaffAuth), not a shared password -- so every save is
// attributed to the actual logged-in doctor/staff member. Deliberately
// reuses bookings-manager's shared lib/ (supabase-client.js, auth.js,
// audit.js) rather than duplicating them, since those have no
// prescription-specific logic in them.
//
// All prescription-specific data lives in derm_rx_* tables, fully
// separate from CRIS ClinicOS's own medicines/prescriptions/billing
// tables in this same Supabase project -- see the derm_rx_* table
// comments (via Supabase) for the reasoning; this stays a parallel
// system until a deliberate future reconciliation, not something to
// unify silently here.

const { createServiceRoleClient, ok } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");
const { makeLogAudit } = require("./lib/audit");

const rx = require("./lib/rx");
const rxMedia = require("./lib/rx-media");
const rxSettings = require("./lib/rx-settings");

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
  // Prescription actions should only be usable by doctors -- a
  // receptionist or pharmacist logging into /bookings-manager
  // shouldn't also be able to write clinical prescription content
  // through this endpoint just because they hold a valid staff JWT.
  if (profile.role !== "doctor") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only doctor accounts can access the prescription system." }) };
  }

  const logAudit = makeLogAudit(supabase, profile);

  try {
    switch (action) {
      // ---- Boot / master data ----
      case "get_init_data":
        return await rx.getInitData(supabase);
      case "get_inventory":
        return await rx.getInventory(supabase);

      // ---- Prescriptions ----
      case "get_patient_rx_history":
        return await rx.getPatientRxHistory(supabase, data);
      case "get_rx_by_id":
        return await rx.getRxById(supabase, data);
      case "save_prescription": {
        const result = await rx.savePrescription(supabase, data, profile);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("RX_CREATE", `Saved prescription for patient ${data.patientId}`);
        return result;
      }
      case "update_prescription_pdf":
        return await rx.updatePrescriptionPdf(supabase, data);

      // ---- Lab reports & photos (metadata only -- files on Drive) ----
      case "get_patient_lab_history":
        return await rxMedia.getPatientLabHistory(supabase, data);
      case "get_patient_photos":
        return await rxMedia.getPatientPhotos(supabase, data);
      case "record_lab_order":
        return await rxMedia.recordLabOrder(supabase, data, profile);
      case "update_lab_note":
        return await rxMedia.updateLabNote(supabase, data);
      case "record_photo":
        return await rxMedia.recordPhoto(supabase, data, profile);

      // ---- Settings: medicines, templates, dx protocols, billing master ----
      case "list_medicines":
        return await rxSettings.listMedicines(supabase);
      case "upsert_medicine": {
        const result = await rxSettings.upsertMedicine(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("SETTINGS_CHANGE", `Saved medicine: ${data.name}`);
        return result;
      }
      case "delete_medicine":
        await logAudit("SETTINGS_CHANGE", `Deactivated medicine ${data.id}`);
        return await rxSettings.deleteMedicine(supabase, data);
      case "list_templates":
        return await rxSettings.listTemplates(supabase);
      case "upsert_template": {
        const result = await rxSettings.upsertTemplate(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("SETTINGS_CHANGE", `Saved ${data.templateType} template: ${data.name}`);
        return result;
      }
      case "delete_template":
        await logAudit("SETTINGS_CHANGE", `Deleted template ${data.id}`);
        return await rxSettings.deleteTemplate(supabase, data);
      case "list_dx_protocols":
        return await rxSettings.listDxProtocols(supabase);
      case "upsert_dx_protocol": {
        const result = await rxSettings.upsertDxProtocol(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("SETTINGS_CHANGE", `Saved dx protocol: ${data.keyword}`);
        return result;
      }
      case "delete_dx_protocol":
        await logAudit("SETTINGS_CHANGE", `Deleted dx protocol ${data.id}`);
        return await rxSettings.deleteDxProtocol(supabase, data);
      case "list_billing_items":
        return await rxSettings.listBillingItems(supabase);
      case "upsert_billing_item": {
        const result = await rxSettings.upsertBillingItem(supabase, data);
        if (result.statusCode && result.statusCode !== 200) return result;
        await logAudit("SETTINGS_CHANGE", `Saved billing item: ${data.name}`);
        return result;
      }
      case "delete_billing_item":
        await logAudit("SETTINGS_CHANGE", `Deactivated billing item ${data.id}`);
        return await rxSettings.deleteBillingItem(supabase, data);

      // ---- Whoami (used by the frontend to show doctor name/role) ----
      case "whoami":
        return ok({ profile: { id: profile.id, full_name: profile.full_name, role: profile.role } });

      default:
        return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
    }
  } catch (error) {
    console.error("prescription-manager error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Something went wrong.",
        debug: { name: error.name, stack: error.stack?.split("\n").slice(0, 3) },
      }),
    };
  }
};

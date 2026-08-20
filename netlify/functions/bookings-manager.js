// netlify/functions/bookings-manager.js
//
// Backend for the standalone /bookings-manager tool (separate from
// /staff-admin, which uses a single shared ADMIN_PASSWORD). This
// function authenticates each request via a real Supabase Auth JWT
// (per-staff-member login, created directly in Supabase by the
// clinic), not a shared password -- every action is attributed to the
// actual logged-in staff member for the audit log, matching the old
// Firebase tool's per-person login model.
//
// This file is now a thin router only: parse the request, verify
// staff auth, then dispatch to the appropriate module in ./lib/.
// Previously this was a single ~1100-line file with every action
// inline; split into modules (patients, registrations, appointments,
// schedule, payments, cash) so each area can be edited/reviewed in
// isolation. This split happened alongside adding field-level
// encryption for patient PII (name/phone/dob/address), which is why
// ./lib/patients.js and ./lib/registrations.js in particular look
// substantially different from their original inline versions --
// see those files' own header comments for what changed and why.

const { createServiceRoleClient, ok } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");
const { makeLogAudit } = require("./lib/audit");

const patients = require("./lib/patients");
const registrations = require("./lib/registrations");
const appointments = require("./lib/appointments");
const schedule = require("./lib/schedule");
const payments = require("./lib/payments");
const cash = require("./lib/cash");

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

  const staffName = profile.full_name;
  const logAudit = makeLogAudit(supabase, profile);

  try {
    switch (action) {
      // ---- Appointments ----
      case "list_appointments":
        return await appointments.listAppointments(supabase, data);
      case "create_appointment":
        return await appointments.createAppointment(supabase, data, staffName, profile.id, logAudit);
      case "update_appointment_status":
        return await appointments.updateAppointmentStatus(supabase, data, logAudit);
      case "delete_appointment":
        return await appointments.deleteAppointment(supabase, data, logAudit);
      case "update_appointment":
        return await appointments.updateAppointment(supabase, data, staffName, profile.id, logAudit);

      // ---- Weekly schedule (slot_templates) ----
      case "list_schedule":
        return await schedule.listSchedule(supabase, data);
      case "add_schedule_block":
        return await schedule.addScheduleBlock(supabase, data, logAudit);
      case "update_schedule_block":
        return await schedule.updateScheduleBlock(supabase, data, logAudit);
      case "delete_schedule_block":
        return await schedule.deleteScheduleBlock(supabase, data, logAudit);

      // ---- Exceptions / leave (schedule_overrides) ----
      case "list_overrides":
        return await schedule.listOverrides(supabase, data);
      case "add_override":
        return await schedule.addOverride(supabase, data, logAudit);
      case "remove_override":
        return await schedule.removeOverride(supabase, data, logAudit);

      // ---- Audit log ----
      case "list_audit_log": {
        const { data: rows, error } = await supabase
          .from("booking_audit_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;
        return ok({ logs: rows });
      }

      // ---- Patient lookup & history ----
      case "lookup_patient_by_phone":
        return await patients.lookupPatientByPhone(supabase, data);
      case "get_patient_history":
        return await patients.getPatientHistory(supabase, data);
      case "get_patient_profile":
        return await patients.getPatientProfile(supabase, data);
      case "update_patient_profile":
        return await patients.updatePatientProfile(supabase, data, logAudit);

      // ---- Patient self-registration approval ----
      case "list_registration_requests":
        return await registrations.listRegistrationRequests(supabase, data);
      case "approve_registration_request":
        return await registrations.approveRegistrationRequest(supabase, data, profile, logAudit);
      case "reject_registration_request":
        return await registrations.rejectRegistrationRequest(supabase, data, profile, logAudit);

      // ---- Payments (simple log, not a billing/invoicing system) ----
      case "record_payment":
        return await payments.recordPayment(supabase, data, profile, logAudit);
      case "get_payment_for_appointment":
        return await payments.getPaymentForAppointment(supabase, data);
      case "list_payments_for_date":
        return await payments.listPaymentsForDate(supabase, data);
      case "update_payment":
        return await payments.updatePayment(supabase, data, logAudit);
      case "delete_payment":
        return await payments.deletePayment(supabase, data, logAudit);

      // ---- Expenses ----
      case "record_expense":
        return await cash.recordExpense(supabase, data, profile, logAudit);
      case "list_expenses_for_date":
        return await cash.listExpensesForDate(supabase, data);
      case "delete_expense":
        return await cash.deleteExpense(supabase, data, logAudit);

      // ---- Daily cash session (mandatory opening + closing counts) ----
      case "get_cash_session":
        return await cash.getCashSession(supabase, data);
      case "record_cash_opening":
        return await cash.recordCashOpening(supabase, data, profile, logAudit);
      case "record_cash_closing":
        return await cash.recordCashClosing(supabase, data, profile, logAudit);
      case "record_cash_recount":
        return await cash.recordCashRecount(supabase, data, profile);
      case "list_cash_recounts":
        return await cash.listCashRecounts(supabase, data);

      // ---- Whoami (used by the frontend to show staff name/role) ----
      case "whoami":
        return ok({ profile: { id: profile.id, full_name: profile.full_name, role: profile.role } });

      default:
        return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
    }
  } catch (error) {
    console.error("bookings-manager error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Something went wrong.",
        debug: { name: error.name, stack: error.stack?.split("\n").slice(0, 3) },
      }),
    };
  }
};

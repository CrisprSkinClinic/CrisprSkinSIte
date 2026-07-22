// netlify/functions/bookings-manager.js
//
// Backend for the standalone /bookings-manager tool (separate from
// /staff-admin, which uses a single shared ADMIN_PASSWORD). This
// function authenticates each request via a real Supabase Auth JWT
// (per-staff-member login, created directly in Supabase by the
// clinic), not a shared password -- every action is attributed to the
// actual logged-in staff member for the audit log, matching the old
// Firebase tool's per-person login model.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;

const CLINIC_DOCTOR_IDS = [
  "514ff136-ee45-4d49-89b5-d128d96aef62", // Karthik L
  "d5372165-fc7e-47e8-aee6-ce02e7fefc71", // Narayanan A
  "519dbd89-d3d9-4ee9-8923-5fabbe51cf2e", // Narayanan B
];

const DAY_ORDER = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!createClient) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server module @supabase/supabase-js failed to load." }) };
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Supabase environment variables are missing." }) };
  }

  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      constructor() {}
      close() {}
      send() {}
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { accessToken, action, data } = payload;
  if (!accessToken) {
    return { statusCode: 401, body: JSON.stringify({ error: "Missing access token. Please sign in again." }) };
  }

  // Service-role client for all actual data operations (bypasses RLS --
  // access is gated by verifying the caller's own token below, not by
  // RLS policies on these tables).
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Verify the token identifies a real, current Supabase Auth user
  // before doing anything else. This replaces the Firebase tool's
  // onAuthStateChanged check -- every request re-verifies identity
  // server-side rather than trusting a client-held session.
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Session expired or invalid. Please sign in again." }) };
  }
  const authUserId = userData.user.id;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", authUserId)
    .single();
  if (profileError || !profile) {
    return { statusCode: 403, body: JSON.stringify({ error: "No staff profile found for this account." }) };
  }
  if (!profile.is_active) {
    return { statusCode: 403, body: JSON.stringify({ error: "This staff account has been deactivated." }) };
  }

  const staffName = profile.full_name;

  async function logAudit(actionName, details) {
    // Best-effort -- an audit log failure should never block the actual
    // booking action from completing, matching the Firebase tool's
    // "if it fails, it fails, no local fallback" comment but without
    // letting that failure cascade into the real operation failing too.
    try {
      await supabase.from("booking_audit_log").insert({
        action: actionName,
        details,
        performed_by: staffName,
        performed_by_profile_id: profile.id,
      });
    } catch (e) {
      console.error("Audit log write failed:", e);
    }
  }

  try {
    switch (action) {
      // ---- Appointments ----

      case "list_appointments": {
        let query = supabase
          .from("appointments")
          .select("*, patients(name, phone), doctors(name), booked_by_profile:profiles!appointments_booked_by_fkey(full_name)")
          .order("slot_date", { ascending: true })
          .order("slot_time", { ascending: true });
        if (data?.date) query = query.eq("slot_date", data.date);
        if (data?.doctor_id && data.doctor_id !== "any") query = query.eq("doctor_id", data.doctor_id);
        const { data: rows, error } = await query;
        if (error) throw error;
        return ok({ appointments: rows });
      }

      case "create_appointment": {
        return await createAppointment(supabase, data, staffName, profile.id, logAudit);
      }

      case "update_appointment_status": {
        const { data: appt, error: fetchErr } = await supabase
          .from("appointments")
          .select("linked_group_id, patients(name)")
          .eq("id", data.id)
          .single();
        if (fetchErr) throw fetchErr;

        const targetIds = appt.linked_group_id
          ? (await supabase.from("appointments").select("id").eq("linked_group_id", appt.linked_group_id)).data.map((r) => r.id)
          : [data.id];

        const { error } = await supabase.from("appointments").update({ status: data.status }).in("id", targetIds);
        if (error) throw error;

        await logAudit("UPDATE", `Changed status to ${data.status} for ${appt.patients?.name || "patient"}`);
        return ok({ success: true });
      }

      case "delete_appointment": {
        const { data: appt, error: fetchErr } = await supabase
          .from("appointments")
          .select("linked_group_id, patients(name)")
          .eq("id", data.id)
          .single();
        if (fetchErr) throw fetchErr;

        const targetIds = appt.linked_group_id
          ? (await supabase.from("appointments").select("id").eq("linked_group_id", appt.linked_group_id)).data.map((r) => r.id)
          : [data.id];

        const { error } = await supabase.from("appointments").delete().in("id", targetIds);
        if (error) throw error;

        await logAudit("DELETE", `Deleted appointment for ${appt.patients?.name || "patient"}`);
        return ok({ success: true });
      }

      case "update_appointment": {
        // Covers both "Edit" (same slot, changed patient/service details)
        // and "Reschedule" (changed date/time/doctor). Rather than
        // mutating the existing row(s) in place -- which would mean
        // re-implementing all of createAppointment's capacity-checking,
        // multi-slot linking, and "any available" doctor-assignment
        // logic a second time and risking the two paths drifting apart
        // -- this creates the new booking first via the same
        // createAppointment() used for fresh bookings, and only deletes
        // the original row(s) after that succeeds. This ordering means
        // a failed reschedule leaves the patient's original appointment
        // intact rather than deleting it and then failing to create
        // the replacement.
        if (!data.originalAppointmentId) {
          return { statusCode: 400, body: JSON.stringify({ error: "originalAppointmentId is required for update_appointment." }) };
        }

        const { data: original, error: fetchErr } = await supabase
          .from("appointments")
          .select("linked_group_id")
          .eq("id", data.originalAppointmentId)
          .single();
        if (fetchErr) throw fetchErr;

        const createResult = await createAppointment(supabase, data, staffName, profile.id, logAudit);
        // createAppointment returns a Netlify-style response object
        // ({ statusCode, body }) on validation/capacity failure rather
        // than throwing -- surface that failure as-is without touching
        // the original appointment.
        if (createResult.statusCode && createResult.statusCode !== 200) {
          return createResult;
        }

        const oldTargetIds = original.linked_group_id
          ? (await supabase.from("appointments").select("id").eq("linked_group_id", original.linked_group_id)).data.map((r) => r.id)
          : [data.originalAppointmentId];
        const { error: deleteError } = await supabase.from("appointments").delete().in("id", oldTargetIds);
        if (deleteError) throw deleteError;

        await logAudit(
          data.isReschedule ? "RESCHEDULE" : "UPDATE",
          `${data.isReschedule ? "Rescheduled" : "Edited"} appointment for ${data.patientName || "patient"}`
        );
        return createResult;
      }

      // ---- Weekly schedule (slot_templates) ----

      case "list_schedule": {
        let query = supabase.from("slot_templates").select("*").order("day_of_week").order("session_start");
        if (data?.doctor_id) query = query.eq("doctor_id", data.doctor_id);
        const { data: rows, error } = await query;
        if (error) throw error;
        return ok({ sessions: rows });
      }

      case "add_schedule_block": {
        if (!data.doctor_id || !data.day_of_week || !data.start_time || !data.end_time) {
          return { statusCode: 400, body: JSON.stringify({ error: "doctor_id, day_of_week, start_time and end_time are all required." }) };
        }
        const { error } = await supabase.from("slot_templates").insert({
          doctor_id: data.doctor_id,
          day_of_week: data.day_of_week,
          session_start: data.start_time,
          session_end: data.end_time,
          max_per_slot: data.max_per_slot || 1,
          is_active: true,
        });
        if (error) throw error;
        await logAudit("SCHEDULE_CHANGE", `Added ${data.day_of_week} ${data.start_time}-${data.end_time} for doctor ${data.doctor_id}`);
        return ok({ success: true });
      }

      case "update_schedule_block": {
        const { error } = await supabase
          .from("slot_templates")
          .update({ session_start: data.start_time, session_end: data.end_time })
          .eq("id", data.id);
        if (error) throw error;
        await logAudit("SCHEDULE_CHANGE", `Updated schedule block ${data.id}`);
        return ok({ success: true });
      }

      case "delete_schedule_block": {
        const { error } = await supabase.from("slot_templates").delete().eq("id", data.id);
        if (error) throw error;
        await logAudit("SCHEDULE_CHANGE", `Removed schedule block ${data.id}`);
        return ok({ success: true });
      }

      // ---- Exceptions / leave (schedule_overrides) ----

      case "list_overrides": {
        let query = supabase.from("schedule_overrides").select("*").order("override_date");
        if (data?.doctor_id) query = query.eq("doctor_id", data.doctor_id);
        const { data: rows, error } = await query;
        if (error) throw error;
        return ok({ overrides: rows });
      }

      case "add_override": {
        if (!data.doctor_id || !data.override_date || !data.override_type) {
          return { statusCode: 400, body: JSON.stringify({ error: "doctor_id, override_date and override_type are required." }) };
        }
        const insertRow = {
          doctor_id: data.doctor_id,
          override_date: data.override_date,
          override_type: data.override_type,
          reason: data.reason || null,
        };
        if (data.override_type === "modified") {
          insertRow.modified_start = data.modified_start;
          insertRow.modified_end = data.modified_end;
        }
        if (data.override_type === "blocked_slot") {
          insertRow.blocked_slot = data.blocked_slot;
        }
        const { error } = await supabase.from("schedule_overrides").insert(insertRow);
        if (error) throw error;
        await logAudit(
          "SCHEDULE_CHANGE",
          data.override_type === "leave"
            ? `Marked ${data.override_date} as leave for doctor ${data.doctor_id}`
            : `Added ${data.override_type} override on ${data.override_date} for doctor ${data.doctor_id}`
        );
        return ok({ success: true });
      }

      case "remove_override": {
        const { error } = await supabase.from("schedule_overrides").delete().eq("id", data.id);
        if (error) throw error;
        await logAudit("SCHEDULE_CHANGE", `Removed schedule override ${data.id}`);
        return ok({ success: true });
      }

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

      case "lookup_patient_by_phone": {
        if (!data?.phone) {
          return { statusCode: 400, body: JSON.stringify({ error: "phone is required." }) };
        }
        const { data: patients, error } = await supabase
          .from("patients")
          .select("id, name, phone")
          .eq("phone", data.phone)
          .limit(1);
        if (error) throw error;
        if (!patients || patients.length === 0) {
          return ok({ found: false });
        }
        // Also surface the doctor from their most recent non-cancelled
        // appointment, so the booking form can suggest "last seen by"
        // for a Review visit without a second round trip.
        const { data: lastAppt } = await supabase
          .from("appointments")
          .select("doctor_id, slot_date, doctors(name)")
          .eq("patient_id", patients[0].id)
          .not("status", "in", "(cancelled)")
          .order("slot_date", { ascending: false })
          .limit(1);
        return ok({
          found: true,
          patient: patients[0],
          lastDoctorId: lastAppt?.[0]?.doctor_id || null,
          lastDoctorName: lastAppt?.[0]?.doctors?.name || null,
          lastVisitDate: lastAppt?.[0]?.slot_date || null,
        });
      }

      case "get_patient_history": {
        if (!data?.patient_id) {
          return { statusCode: 400, body: JSON.stringify({ error: "patient_id is required." }) };
        }
        const { data: visits, error } = await supabase
          .from("appointments")
          .select("*, doctors(name)")
          .eq("patient_id", data.patient_id)
          .order("slot_date", { ascending: false })
          .order("slot_time", { ascending: false });
        if (error) throw error;
        return ok({ visits });
      }

      // ---- Whoami (used by the frontend to show staff name/role) ----

      case "get_patient_profile": {
        if (!data?.patient_id) {
          return { statusCode: 400, body: JSON.stringify({ error: "patient_id is required." }) };
        }
        const { data: patientRow, error } = await supabase
          .from("patients")
          .select("*")
          .eq("id", data.patient_id)
          .single();
        if (error) throw error;
        return ok({ patient: patientRow });
      }

      case "update_patient_profile": {
        if (!data?.patient_id) {
          return { statusCode: 400, body: JSON.stringify({ error: "patient_id is required." }) };
        }
        // gender is constrained at the database level to
        // male/female/other (patients_gender_check) -- validated here
        // too so a bad value produces a readable error instead of a
        // raw Postgres constraint violation message.
        if (data.gender && !["male", "female", "other"].includes(data.gender)) {
          return { statusCode: 400, body: JSON.stringify({ error: "Gender must be male, female, or other." }) };
        }
        const updateFields = {};
        if (data.name !== undefined) updateFields.name = data.name;
        if (data.phone !== undefined) updateFields.phone = data.phone || null;
        if (data.dob !== undefined) updateFields.dob = data.dob || null;
        if (data.gender !== undefined) updateFields.gender = data.gender || null;
        if (data.address !== undefined) updateFields.address = data.address || null;
        updateFields.updated_at = new Date().toISOString();

        const { error } = await supabase.from("patients").update(updateFields).eq("id", data.patient_id);
        if (error) throw error;

        await logAudit("UPDATE", `Updated patient profile for patient ${data.patient_id}`);
        return ok({ success: true });
      }

      // ---- Payments (simple log, not a billing/invoicing system) ----

      case "record_payment": {
        // lineItems is an array of { category, consultationSubtype?,
        // amount }, 1+ entries -- one payment event (one visit's total
        // bill, one set of mode splits) can now cover multiple
        // categories at once, e.g. consultation + labs + pharmacy in a
        // single payment. splits (mode breakdown) applies to the
        // combined total across all line items, not per-category, per
        // explicit confirmation that a patient doesn't pay "cash for
        // consultation, card for pharmacy" separately in the normal case.
        if ((!data?.patient_id && !data?.new_patient_name) || !Array.isArray(data.lineItems) || data.lineItems.length === 0) {
          return { statusCode: 400, body: JSON.stringify({ error: "A patient (existing patient_id or new_patient_name) and at least one category line-item are required." }) };
        }
        const validCategories = ["consultation", "pharmacy", "lab", "vaccination", "procedure"];
        const validSubtypes = ["new", "review", "free"];

        let resolvedPatientId = data.patient_id || null;
        if (!resolvedPatientId && data.new_patient_name) {
          const { data: newPatient, error: newPatientErr } = await supabase
            .from("patients")
            .insert({ name: data.new_patient_name, phone: data.new_patient_phone || null, is_registered: false })
            .select("id")
            .single();
          if (newPatientErr) throw newPatientErr;
          resolvedPatientId = newPatient.id;
        }

        let lineItemsTotal = 0;
        let hasFreeConsultation = false;
        for (const item of data.lineItems) {
          if (!validCategories.includes(item.category)) {
            return { statusCode: 400, body: JSON.stringify({ error: `Invalid category: ${item.category}` }) };
          }
          if (item.category === "consultation") {
            if (!validSubtypes.includes(item.consultationSubtype)) {
              return { statusCode: 400, body: JSON.stringify({ error: "consultationSubtype (new/review/free) is required for a consultation line-item." }) };
            }
            if (item.consultationSubtype === "free") hasFreeConsultation = true;
          } else if (item.consultationSubtype) {
            return { statusCode: 400, body: JSON.stringify({ error: `consultationSubtype should not be set for a ${item.category} line-item.` }) };
          }
          if (typeof item.amount !== "number" || item.amount < 0) {
            return { statusCode: 400, body: JSON.stringify({ error: "Each line-item needs a valid, non-negative amount." }) };
          }
          lineItemsTotal += item.amount;
        }

        const validModes = ["cash", "card", "upi", "other"];
        const splits = Array.isArray(data.splits) ? data.splits : [];
        let splitTotal = 0;
        for (const split of splits) {
          if (!validModes.includes(split.mode) || typeof split.amount !== "number" || split.amount <= 0) {
            return { statusCode: 400, body: JSON.stringify({ error: "Each payment split needs a valid mode and a positive amount." }) };
          }
          splitTotal += split.amount;
        }

        // A visit that's ENTIRELY a free consultation (the only
        // line-item) has no splits at all. A visit with a free
        // consultation ALONGSIDE other paid categories (e.g. free
        // consult + paid labs) still needs splits covering the paid
        // portion -- lineItemsTotal already reflects that correctly
        // since the free line-item contributes 0.
        if (lineItemsTotal === 0) {
          if (splits.length !== 0) {
            return { statusCode: 400, body: JSON.stringify({ error: "A visit totaling ₹0 (e.g. entirely free) should have no payment splits." }) };
          }
        } else if (Math.abs(splitTotal - lineItemsTotal) > 0.01) {
          return { statusCode: 400, body: JSON.stringify({ error: `Payment splits (₹${splitTotal}) must add up to the line-items total (₹${lineItemsTotal}).` }) };
        }

        const { data: entry, error: entryError } = await supabase
          .from("payment_entries")
          .insert({
            appointment_id: data.appointment_id || null,
            patient_id: resolvedPatientId,
            total_amount: lineItemsTotal,
            collected_by: profile.id,
            notes: data.notes || null,
          })
          .select("id")
          .single();
        if (entryError) throw entryError;

        const { error: lineItemsError } = await supabase.from("payment_line_items").insert(
          data.lineItems.map((item) => ({
            payment_entry_id: entry.id,
            category: item.category,
            consultation_subtype: item.category === "consultation" ? item.consultationSubtype : null,
            amount: item.amount,
          }))
        );
        if (lineItemsError) throw lineItemsError;

        if (splits.length > 0) {
          const { error: splitsError } = await supabase
            .from("payment_splits")
            .insert(splits.map((s) => ({ payment_entry_id: entry.id, mode: s.mode, amount: s.amount })));
          if (splitsError) throw splitsError;
        }

        const categorySummary = data.lineItems.map((i) => (i.category === "consultation" ? `consultation (${i.consultationSubtype})` : i.category)).join(", ");
        await logAudit("CREATE", `Recorded ₹${lineItemsTotal} payment (${categorySummary}) for patient ${resolvedPatientId}`);
        return ok({ success: true, paymentId: entry.id });
      }

      case "list_payments_for_date": {
        if (!data?.date) {
          return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
        }
        const startOfDay = `${data.date}T00:00:00.000Z`;
        const endOfDay = `${data.date}T23:59:59.999Z`;
        const { data: payments, error } = await supabase
          .from("payment_entries")
          .select(
            "*, patients(name), collected_by_profile:profiles!payment_entries_collected_by_fkey(full_name), payment_splits(mode, amount), payment_line_items(category, consultation_subtype, amount)"
          )
          .gte("created_at", startOfDay)
          .lte("created_at", endOfDay)
          .order("created_at", { ascending: true });
        if (error) throw error;
        return ok({ payments });
      }

      case "delete_payment": {
        const { data: payment, error: fetchErr } = await supabase
          .from("payment_entries")
          .select("total_amount, patients(name), payment_line_items(category)")
          .eq("id", data.id)
          .single();
        if (fetchErr) throw fetchErr;

        // payment_splits and payment_line_items rows cascade-delete
        // automatically (both have on delete cascade on
        // payment_entry_id), so only the parent needs deleting
        // explicitly here.
        const { error } = await supabase.from("payment_entries").delete().eq("id", data.id);
        if (error) throw error;

        const categories = (payment.payment_line_items || []).map((li) => li.category).join(", ") || "unknown category";
        await logAudit("DELETE", `Deleted ₹${payment.total_amount} payment entry (${categories}) for ${payment.patients?.name || "patient"}`);
        return ok({ success: true });
      }

      // ---- Expenses ----

      case "record_expense": {
        if (!data?.category || !data?.amount) {
          return { statusCode: 400, body: JSON.stringify({ error: "category and amount are required." }) };
        }
        const validExpenseCategories = ["bank_deposit", "handed_to_doctor", "petty_expense", "other"];
        if (!validExpenseCategories.includes(data.category)) {
          return { statusCode: 400, body: JSON.stringify({ error: "Invalid expense category." }) };
        }
        const amountNum = Number(data.amount);
        if (Number.isNaN(amountNum) || amountNum <= 0) {
          return { statusCode: 400, body: JSON.stringify({ error: "Amount must be a positive number." }) };
        }
        const { data: expense, error } = await supabase
          .from("expense_entries")
          .insert({ category: data.category, amount: amountNum, notes: data.notes || null, recorded_by: profile.id })
          .select("id")
          .single();
        if (error) throw error;

        await logAudit("CREATE", `Recorded expense: ₹${amountNum} (${data.category})`);
        return ok({ success: true, expenseId: expense.id });
      }

      case "list_expenses_for_date": {
        if (!data?.date) {
          return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
        }
        const startOfDay = `${data.date}T00:00:00.000Z`;
        const endOfDay = `${data.date}T23:59:59.999Z`;
        const { data: expenses, error } = await supabase
          .from("expense_entries")
          .select("*, recorded_by_profile:profiles!expense_entries_recorded_by_fkey(full_name)")
          .gte("created_at", startOfDay)
          .lte("created_at", endOfDay)
          .order("created_at", { ascending: true });
        if (error) throw error;
        return ok({ expenses });
      }

      case "delete_expense": {
        const { error } = await supabase.from("expense_entries").delete().eq("id", data.id);
        if (error) throw error;
        await logAudit("DELETE", `Deleted expense entry ${data.id}`);
        return ok({ success: true });
      }

      // ---- Daily cash session (mandatory opening + closing counts) ----

      case "get_cash_session": {
        if (!data?.date) {
          return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
        }
        const { data: session, error } = await supabase
          .from("daily_cash_sessions")
          .select("*")
          .eq("session_date", data.date)
          .maybeSingle();
        if (error) throw error;

        // Also surface the previous calendar day's closing total, so
        // the frontend can flag a mismatch between yesterday's close
        // and today's opening count -- a common sign the till wasn't
        // actually reconciled properly overnight.
        const prevDate = new Date(`${data.date}T00:00:00Z`);
        prevDate.setUTCDate(prevDate.getUTCDate() - 1);
        const prevDateStr = prevDate.toISOString().slice(0, 10);
        const { data: prevSession } = await supabase
          .from("daily_cash_sessions")
          .select("closing_total")
          .eq("session_date", prevDateStr)
          .maybeSingle();

        return ok({ session: session || null, previousClosingTotal: prevSession?.closing_total ?? null });
      }

      case "record_cash_opening": {
        if (!data?.date) {
          return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
        }
        const counts = {
          opening_count_50: Number(data.count50) || 0,
          opening_count_100: Number(data.count100) || 0,
          opening_count_200: Number(data.count200) || 0,
          opening_count_500: Number(data.count500) || 0,
        };
        const openingTotal = counts.opening_count_50 * 50 + counts.opening_count_100 * 100 + counts.opening_count_200 * 200 + counts.opening_count_500 * 500;

        const { error } = await supabase.from("daily_cash_sessions").upsert(
          {
            session_date: data.date,
            ...counts,
            opening_total: openingTotal,
            opening_recorded_by: profile.id,
            opening_recorded_at: new Date().toISOString(),
          },
          { onConflict: "session_date" }
        );
        if (error) throw error;

        await logAudit("CREATE", `Recorded opening cash count for ${data.date}: ₹${openingTotal}`);
        return ok({ success: true, openingTotal });
      }

      case "record_cash_closing": {
        if (!data?.date) {
          return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
        }
        const { data: existingSession, error: fetchErr } = await supabase
          .from("daily_cash_sessions")
          .select("opening_total")
          .eq("session_date", data.date)
          .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!existingSession || existingSession.opening_total === null) {
          return { statusCode: 400, body: JSON.stringify({ error: "Opening cash count must be recorded before closing for this date." }) };
        }

        const counts = {
          closing_count_50: Number(data.count50) || 0,
          closing_count_100: Number(data.count100) || 0,
          closing_count_200: Number(data.count200) || 0,
          closing_count_500: Number(data.count500) || 0,
        };
        const closingTotal = counts.closing_count_50 * 50 + counts.closing_count_100 * 100 + counts.closing_count_200 * 200 + counts.closing_count_500 * 500;

        // expected_closing = opening + cash payments today - cash expenses today
        const startOfDay = `${data.date}T00:00:00.000Z`;
        const endOfDay = `${data.date}T23:59:59.999Z`;
        const { data: cashSplits } = await supabase
          .from("payment_splits")
          .select("amount, payment_entries!inner(created_at)")
          .eq("mode", "cash")
          .gte("payment_entries.created_at", startOfDay)
          .lte("payment_entries.created_at", endOfDay);
        const cashCollected = (cashSplits || []).reduce((sum, s) => sum + Number(s.amount), 0);

        const { data: cashExpenses } = await supabase
          .from("expense_entries")
          .select("amount")
          .gte("created_at", startOfDay)
          .lte("created_at", endOfDay);
        const expensesTotal = (cashExpenses || []).reduce((sum, e) => sum + Number(e.amount), 0);

        const expectedClosing = Number(existingSession.opening_total) + cashCollected - expensesTotal;
        const discrepancy = closingTotal - expectedClosing;

        const { error } = await supabase
          .from("daily_cash_sessions")
          .update({
            ...counts,
            closing_total: closingTotal,
            closing_recorded_by: profile.id,
            closing_recorded_at: new Date().toISOString(),
            expected_closing: expectedClosing,
            discrepancy,
          })
          .eq("session_date", data.date);
        if (error) throw error;

        await logAudit(
          "UPDATE",
          `Recorded closing cash count for ${data.date}: ₹${closingTotal} (expected ₹${expectedClosing.toFixed(2)}, discrepancy ₹${discrepancy.toFixed(2)})`
        );
        return ok({ success: true, closingTotal, expectedClosing, discrepancy });
      }

      case "record_cash_recount": {
        if (!data?.date) {
          return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
        }
        const count50 = Number(data.count50) || 0;
        const count100 = Number(data.count100) || 0;
        const count200 = Number(data.count200) || 0;
        const count500 = Number(data.count500) || 0;
        const countedTotal = count50 * 50 + count100 * 100 + count200 * 200 + count500 * 500;

        const { error } = await supabase.from("cash_recounts").insert({
          session_date: data.date,
          count_50: count50,
          count_100: count100,
          count_200: count200,
          count_500: count500,
          counted_total: countedTotal,
          recorded_by: profile.id,
        });
        if (error) throw error;

        return ok({ success: true, countedTotal });
      }

      case "list_cash_recounts": {
        if (!data?.date) {
          return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
        }
        const { data: recounts, error } = await supabase
          .from("cash_recounts")
          .select("*, recorded_by_profile:profiles!cash_recounts_recorded_by_fkey(full_name)")
          .eq("session_date", data.date)
          .order("recorded_at", { ascending: true });
        if (error) throw error;
        return ok({ recounts });
      }

      case "whoami": {
        return ok({ profile: { id: profile.id, full_name: profile.full_name, role: profile.role } });
      }

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

// Handles both single-slot and multi-slot (procedure) appointment
// creation, matching the Firebase tool's mkObj/linkId concept -- one
// linked_group_id ties together all rows belonging to one multi-slot
// booking, and capacity is checked per-doctor per-slot before booking.
async function createAppointment(supabase, data, staffName, staffProfileId, logAudit) {
  const { patientName, patientPhone, doctorId, date, slots, appointmentType, notes } = data;
  if (!patientName || !doctorId || !date || !Array.isArray(slots) || slots.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientName, doctorId, date, and at least one slot are required." }) };
  }

  // Resolve or create the patient record, matching the phone-lookup
  // pattern already used in public-book-appointment.js. Only attempt a
  // phone-based lookup when a real phone number was given -- matching
  // on an empty string would incorrectly reuse any existing patient
  // row that also happens to have no phone on file.
  let patientId;
  if (patientPhone) {
    const { data: existingPatients } = await supabase.from("patients").select("id").eq("phone", patientPhone).limit(1);
    if (existingPatients && existingPatients.length > 0) {
      patientId = existingPatients[0].id;
    }
  }
  if (!patientId) {
    const { data: newPatient, error: patientErr } = await supabase
      .from("patients")
      .insert({ name: patientName, phone: patientPhone || null, is_registered: false })
      .select("id")
      .single();
    if (patientErr) throw patientErr;
    patientId = newPatient.id;
  }

  const doctorsToCheck = doctorId === "any" ? CLINIC_DOCTOR_IDS : [doctorId];
  const linkedGroupId = slots.length > 1 ? crypto.randomUUID() : null;
  const insertedRows = [];
  // Overbooking only makes sense against one specific, staff-chosen
  // doctor -- "any available" plus override would mean silently
  // picking who gets double-booked, which isn't a decision to make
  // automatically. The frontend already enforces this (switching off
  // "any" before allowing the override button to appear), but this is
  // re-checked here too since client-side state is not a security or
  // correctness boundary.
  const allowOverbook = data.allowOverbook === true && doctorId !== "any";

  for (const slotTime of slots) {
    // For "any available", pick whichever doctor is actually free at
    // this specific slot -- re-verified here at booking time, same
    // race-condition protection used in public-book-appointment.js.
    let assignedDoctor = null;
    for (const candidateId of doctorId === "any" ? shuffle(doctorsToCheck) : doctorsToCheck) {
      const { count } = await supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("doctor_id", candidateId)
        .eq("slot_date", date)
        .eq("slot_time", slotTime)
        .not("status", "in", "(cancelled)");
      if ((count || 0) === 0) {
        assignedDoctor = candidateId;
        break;
      }
    }
    if (!assignedDoctor) {
      if (allowOverbook) {
        // Staff explicitly confirmed booking anyway despite no free
        // capacity -- proceed with the doctor they chose rather than
        // rejecting. This is a deliberate exception path, not a bug:
        // walk-in patients standing at the desk are a real situation
        // the "no slots" rejection alone doesn't handle.
        assignedDoctor = doctorId;
      } else {
        return { statusCode: 409, body: JSON.stringify({ error: `No doctor available at ${slotTime} -- that slot is fully booked.` }) };
      }
    }

    const { data: newAppt, error } = await supabase
      .from("appointments")
      .insert({
        patient_id: patientId,
        doctor_id: assignedDoctor,
        slot_date: date,
        slot_time: slotTime,
        status: "booked",
        notes: notes || appointmentType,
        linked_group_id: linkedGroupId,
        // Set to the signed-in staff member's profile id -- this is
        // what actually distinguishes a staff-created booking from a
        // public self-service one (public-book-appointment.js always
        // sets this to null). Without this, the two were previously
        // indistinguishable in the database.
        booked_by: staffProfileId,
      })
      .select("id")
      .single();
    if (error) throw error;
    insertedRows.push(newAppt.id);
  }

  await logAudit("CREATE", `Booked ${patientName} for ${appointmentType || "appointment"} on ${date}`);
  return ok({ success: true, appointmentIds: insertedRows });
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function ok(body) {
  return { statusCode: 200, body: JSON.stringify(body) };
}

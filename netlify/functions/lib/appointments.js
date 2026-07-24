// netlify/functions/lib/appointments.js
//
// Appointment listing, creation, status/deletion, and edit/reschedule.
// Logic is otherwise unchanged from the original single-file
// bookings-manager.js -- the only changes here are for encrypted
// patient PII:
//   - list_appointments used to embed "patients(name, phone)" directly
//     in the select; that no longer works since those columns are
//     encrypted (name_enc/phone_enc). Now fetches patient_id only and
//     resolves names/phones separately via resolvePatientNamesMap().
//   - update_appointment_status / delete_appointment used
//     "patients(name)" purely to build an audit-log message; replaced
//     with resolveSinglePatientName().
//   - createAppointment's phone-based existing-patient lookup used
//     .eq("phone", patientPhone), which can't match encrypted values;
//     now uses the find_patient_by_phone RPC (hash-based lookup), and
//     new-patient insertion uses insert_patient_encrypted instead of a
//     direct .insert().

const { ok } = require("./supabase-client");
const { resolvePatientNamesMap, resolveSinglePatientName } = require("./patient-names");

const CLINIC_DOCTOR_IDS = [
  "514ff136-ee45-4d49-89b5-d128d96aef62", // Karthik L
  "d5372165-fc7e-47e8-aee6-ce02e7fefc71", // Narayanan A
  "519dbd89-d3d9-4ee9-8923-5fabbe51cf2e", // Narayanan B
];

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function listAppointments(supabase, data) {
  let query = supabase
    .from("appointments")
    .select("*, doctors(name), booked_by_profile:profiles!appointments_booked_by_fkey(full_name)")
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });
  if (data?.date) query = query.eq("slot_date", data.date);
  if (data?.doctor_id && data.doctor_id !== "any") query = query.eq("doctor_id", data.doctor_id);
  const { data: rows, error } = await query;
  if (error) throw error;

  const nameMap = await resolvePatientNamesMap(supabase, rows.map((r) => r.patient_id));
  const appointments = rows.map((r) => ({
    ...r,
    patients: nameMap.has(r.patient_id) ? { name: nameMap.get(r.patient_id).name, phone: nameMap.get(r.patient_id).phone } : null,
  }));
  return ok({ appointments });
}

async function updateAppointmentStatus(supabase, data, logAudit) {
  const { data: appt, error: fetchErr } = await supabase
    .from("appointments")
    .select("linked_group_id, patient_id")
    .eq("id", data.id)
    .single();
  if (fetchErr) throw fetchErr;

  const targetIds = appt.linked_group_id
    ? (await supabase.from("appointments").select("id").eq("linked_group_id", appt.linked_group_id)).data.map((r) => r.id)
    : [data.id];

  const { error } = await supabase.from("appointments").update({ status: data.status }).in("id", targetIds);
  if (error) throw error;

  const patientName = await resolveSinglePatientName(supabase, appt.patient_id);
  await logAudit("UPDATE", `Changed status to ${data.status} for ${patientName || "patient"}`);
  return ok({ success: true });
}

async function deleteAppointment(supabase, data, logAudit) {
  const { data: appt, error: fetchErr } = await supabase
    .from("appointments")
    .select("linked_group_id, patient_id")
    .eq("id", data.id)
    .single();
  if (fetchErr) throw fetchErr;

  const targetIds = appt.linked_group_id
    ? (await supabase.from("appointments").select("id").eq("linked_group_id", appt.linked_group_id)).data.map((r) => r.id)
    : [data.id];

  const { error } = await supabase.from("appointments").delete().in("id", targetIds);
  if (error) throw error;

  const patientName = await resolveSinglePatientName(supabase, appt.patient_id);
  await logAudit("DELETE", `Deleted appointment for ${patientName || "patient"}`);
  return ok({ success: true });
}

async function updateAppointment(supabase, data, staffName, staffProfileId, logAudit) {
  // Covers both "Edit" (same slot, changed patient/service details) and
  // "Reschedule" (changed date/time/doctor). Rather than mutating the
  // existing row(s) in place -- which would mean re-implementing all of
  // createAppointment's capacity-checking, multi-slot linking, and "any
  // available" doctor-assignment logic a second time and risking the
  // two paths drifting apart -- this creates the new booking first via
  // the same createAppointment() used for fresh bookings, and only
  // deletes the original row(s) after that succeeds. This ordering
  // means a failed reschedule leaves the patient's original appointment
  // intact rather than deleting it and then failing to create the
  // replacement.
  if (!data.originalAppointmentId) {
    return { statusCode: 400, body: JSON.stringify({ error: "originalAppointmentId is required for update_appointment." }) };
  }

  const { data: original, error: fetchErr } = await supabase
    .from("appointments")
    .select("linked_group_id")
    .eq("id", data.originalAppointmentId)
    .single();
  if (fetchErr) throw fetchErr;

  const createResult = await createAppointment(supabase, data, staffName, staffProfileId, logAudit);
  // createAppointment returns a Netlify-style response object
  // ({ statusCode, body }) on validation/capacity failure rather than
  // throwing -- surface that failure as-is without touching the
  // original appointment.
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
  // row that also happens to have no phone on file. Uses the
  // find_patient_by_phone RPC (hash-based) since phone_enc can't be
  // searched with a direct equality filter.
  let patientId;
  if (patientPhone) {
    const { data: existingRows } = await supabase.rpc("find_patient_by_phone", { p_phone: patientPhone });
    if (existingRows && existingRows.length > 0) {
      patientId = existingRows[0].id;
    }
  }
  if (!patientId) {
    const { data: newPatientId, error: patientErr } = await supabase.rpc("insert_patient_encrypted", {
      p_name: patientName,
      p_phone: patientPhone || null,
      p_dob: null,
      p_gender: null,
      p_address: null,
      p_is_registered: false,
    });
    if (patientErr) throw patientErr;
    patientId = newPatientId;
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

module.exports = { listAppointments, updateAppointmentStatus, deleteAppointment, updateAppointment, createAppointment };

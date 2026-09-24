// netlify/functions/manage-appointments.js
//
// "Manage my appointment" on the website. After the patient verifies their
// WhatsApp number (send-booking-otp / verify-booking-otp), this lists the
// upcoming appointments of every patient registered on that number (family
// members often share one) and lets them reschedule or cancel.
//
// Every action re-checks the phone's verification token (without consuming
// it, so several changes can be made within its 30 minutes) and that the
// appointment belongs to a patient on that phone. Only a plain single-slot
// appointment still in "booked" status can be changed online; anything else
// is left to reception.
//
// POST { action: "list" | "reschedule" | "cancel", phone, otpToken, ... }

const core = require("./lib/booking-core");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return core.json(405, { error: "Method Not Allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return core.json(400, { error: "Invalid request body" });
  }

  const canonicalPhone = core.canonicalIndianMobile(payload.phone);
  if (!canonicalPhone) return core.json(400, { error: "Enter a valid 10-digit Indian mobile number that uses WhatsApp." });

  const { supabase, serviceRoleKey, error: configError } = core.serviceClient();
  if (configError) return core.json(500, { error: "Appointment management is temporarily unavailable." });

  try {
    if (!(await core.tokenIsValid(supabase, canonicalPhone, payload.otpToken))) {
      return core.json(403, { error: "Your verification has expired. Please verify your WhatsApp number again." });
    }
    const patients = await core.patientsOnPhone(supabase, canonicalPhone);

    if (payload.action === "list") return core.json(200, { appointments: await upcoming(supabase, patients) });

    // reschedule / cancel act on one appointment that must belong to this phone.
    const { data: appt, error: apptError } = await supabase
      .from("appointments")
      .select("id, patient_id, doctor_id, slot_date, slot_time, status, linked_group_id, notes, doctors(name)")
      .eq("id", String(payload.appointmentId || ""))
      .is("deleted_at", null)
      .maybeSingle();
    if (apptError && !/uuid/i.test(apptError.message || "")) throw apptError;
    // Only this clinic's appointments are managed here (the database is shared with the eye clinic).
    const patient = appt && core.CLINIC_DOCTOR_IDS.includes(appt.doctor_id) && patients.find((p) => p.id === appt.patient_id);
    if (!appt || !patient) return core.json(404, { error: "Appointment not found for this number." });
    if (!core.canChangeOnline(appt) || core.isPast(appt.slot_date, appt.slot_time)) {
      return core.json(409, { error: "This appointment can't be changed online. Please call the clinic." });
    }
    const oldWhen = `${core.displayDate(appt.slot_date)} at ${core.displayTime(appt.slot_time)}${appt.doctors?.name ? ` with Dr. ${appt.doctors.name}` : ""}`;

    if (payload.action === "cancel") {
      const { data: cancelled, error: cancelError } = await supabase
        .from("appointments")
        .update({ status: "cancelled", notes: core.appendNote(appt.notes, "Cancelled via website") })
        .eq("id", appt.id)
        .eq("status", "booked")
        .select("id")
        .maybeSingle();
      if (cancelError) throw cancelError;
      if (!cancelled) return core.json(409, { error: "This appointment can't be changed online. Please call the clinic." });
      await core.logForReception(supabase, "APPOINTMENT_CANCEL", `${patient.name} cancelled their appointment on ${oldWhen} via website`);
      return core.json(200, { success: true, cancelled: true });
    }

    if (payload.action === "reschedule") {
      const slotDate = String(payload.date || "");
      const slotTime = core.normalizeTime(String(payload.time || ""));
      if (!slotDate || !slotTime) return core.json(400, { error: "Choose a new date and time." });

      // Same doctor unless the patient picked another (or "no preference").
      const candidates = payload.doctorId && payload.doctorId !== "any"
        ? [String(payload.doctorId)]
        : Array.isArray(payload.candidateDoctorIds) && payload.candidateDoctorIds.length
          ? core.shuffle(payload.candidateDoctorIds.filter((id) => core.CLINIC_DOCTOR_IDS.includes(id)))
          : [appt.doctor_id];
      const slot = await core.findAvailableDoctor(supabase, { slotDate, slotTime, candidates, ignoreAppointmentId: appt.id });
      if (slot.error) return core.json(409, { error: slot.error });

      // One website booking per patient per day also applies to the new date.
      const clash = await core.appointmentOnDay(supabase, patient.id, slotDate, appt.id);
      if (clash) {
        return core.json(409, {
          error: `${patient.name} already has an appointment on ${core.displayDate(slotDate)} at ${core.displayTime(clash.slot_time)}. Only one appointment per day is allowed online — choose another date or call the clinic.`,
        });
      }

      // Update in place: the id is referenced by notifications, bills and records.
      const { data: moved, error: moveError } = await supabase
        .from("appointments")
        .update({ doctor_id: slot.doctorId, slot_date: slotDate, slot_time: slotTime, notes: core.appendNote(appt.notes, "Rescheduled via website") })
        .eq("id", appt.id)
        .eq("status", "booked")
        .select("id")
        .maybeSingle();
      if (moveError) throw moveError;
      if (!moved) return core.json(409, { error: "This appointment can't be changed online. Please call the clinic." });

      const { data: newDoctor } = await supabase.from("doctors").select("name").eq("id", slot.doctorId).maybeSingle();
      const newWhen = `${core.displayDate(slotDate)} at ${core.displayTime(slotTime)}${newDoctor?.name ? ` with Dr. ${newDoctor.name}` : ""}`;
      await core.logForReception(supabase, "APPOINTMENT_RESCHEDULE", `${patient.name} moved their appointment from ${oldWhen} to ${newWhen} via website`);
      await core.sendConfirmation(supabase, {
        serviceRoleKey, canonicalPhone, name: patient.name, doctorId: slot.doctorId, slotDate, slotTime, appointmentId: appt.id,
      });
      return core.json(200, { success: true, rescheduled: true, from: oldWhen, to: newWhen });
    }

    return core.json(400, { error: "Unknown action." });
  } catch (error) {
    console.error("manage-appointments error:", error.message);
    return core.json(500, { error: "Something went wrong. Please try again or call the clinic." });
  }
};

// Upcoming, not-cancelled appointments for these patients, one entry per visit
// (a multi-slot reception booking is several rows sharing linked_group_id).
async function upcoming(supabase, patients) {
  if (!patients.length) return [];
  const nameById = new Map(patients.map((p) => [p.id, p.name]));
  const { data, error } = await supabase
    .from("appointments")
    .select("id, patient_id, doctor_id, slot_date, slot_time, status, linked_group_id, notes, doctors(name)")
    .in("patient_id", patients.map((p) => p.id))
    .in("doctor_id", core.CLINIC_DOCTOR_IDS)
    .gte("slot_date", core.clinicNow().date)
    .in("status", ["booked", "arrived"])
    .is("deleted_at", null)
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });
  if (error) throw error;

  const seen = new Set();
  const visits = [];
  for (const a of data || []) {
    if (core.isPast(a.slot_date, a.slot_time) && a.status === "booked") continue;
    const key = a.linked_group_id || a.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const visitType = String(a.notes || "").split("|").map((s) => s.trim()).filter(Boolean);
    visits.push({
      id: a.id,
      patientName: nameById.get(a.patient_id) || "Patient",
      date: a.slot_date,
      dateLabel: core.displayDate(a.slot_date, true),
      time: core.displayTime(a.slot_time),
      doctorId: a.doctor_id,
      doctorName: a.doctors?.name || null,
      service: visitType[0] === "Review" ? `Review · ${visitType[1] || "Consultation"}` : visitType[0] || "Consultation",
      status: a.status,
      canChange: core.canChangeOnline(a) && !core.isPast(a.slot_date, a.slot_time),
    });
  }
  return visits;
}

// netlify/functions/review-book.js
//
// Books a REVIEW appointment from the review page (/review) for a patient on a verified WhatsApp number.
//   - the phone's verification token must be valid (peeked, so the patient can still reschedule or cancel afterwards),
//   - the patient must be registered on that phone,
//   - a patient may have only ONE upcoming appointment: if they already have one they must reschedule or cancel it,
//   - the doctor is the one the patient last saw (the page sends that doctor; the server re-checks it),
//   - it is stored as "Review | Consultation", the label reception's Today screen, filters and payment categories read.
//
// POST { phone, otpToken, patientId, date, time, doctorId?, candidateDoctorIds? }

const core = require("./lib/booking-core");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return core.json(405, { error: "Method Not Allowed" });
  let p;
  try { p = JSON.parse(event.body || "{}"); } catch { return core.json(400, { error: "Invalid request body" }); }

  const phone = core.canonicalIndianMobile(p.phone);
  const slotDate = String(p.date || "");
  const slotTime = core.normalizeTime(String(p.time || ""));
  if (!phone || !p.otpToken) return core.json(400, { error: "Verified phone and verification token are required." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !slotTime) return core.json(400, { error: "Choose a date and time." });
  const { supabase, serviceRoleKey, error: configError } = core.serviceClient();
  if (configError) return core.json(500, { error: "Review booking is temporarily unavailable." });

  try {
    if (!(await core.tokenIsValid(supabase, phone, p.otpToken))) {
      return core.json(403, { error: "Your verification has expired. Please verify your WhatsApp number again." });
    }
    const patient = (await core.patientsOnPhone(supabase, phone)).find((row) => row.id === String(p.patientId || ""));
    if (!patient) return core.json(404, { error: "That patient is not on this number." });

    // One upcoming appointment per patient.
    const { data: existing, error: existingError } = await supabase
      .from("appointments")
      .select("id, slot_date, slot_time, status, doctors!appointments_doctor_id_fkey(name)")
      .eq("patient_id", patient.id)
      .in("doctor_id", core.CLINIC_DOCTOR_IDS)
      .in("status", ["booked", "arrived"])
      .gte("slot_date", core.clinicNow().date)
      .is("deleted_at", null)
      .order("slot_date", { ascending: true })
      .order("slot_time", { ascending: true });
    if (existingError) throw existingError;
    const upcoming = (existing || []).find((a) => !core.isPast(a.slot_date, a.slot_time));
    if (upcoming) {
      return core.json(409, {
        code: "already_booked",
        error: `${patient.name} already has an appointment on ${core.displayDate(upcoming.slot_date)} at ${core.displayTime(upcoming.slot_time)}. Reschedule or cancel it instead of booking another.`,
      });
    }

    const requested = String(p.doctorId || "");
    if (requested && requested !== "any" && !core.CLINIC_DOCTOR_IDS.includes(requested)) return core.json(400, { error: "Unknown doctor." });
    const candidates = requested && requested !== "any"
      ? [requested]
      : core.shuffle((Array.isArray(p.candidateDoctorIds) && p.candidateDoctorIds.length ? p.candidateDoctorIds : core.CLINIC_DOCTOR_IDS).filter((id) => core.CLINIC_DOCTOR_IDS.includes(id)));
    const slot = await core.findAvailableDoctor(supabase, { slotDate, slotTime, candidates });
    if (slot.error) return core.json(409, { error: slot.error });

    const { data: appointment, error: insertError } = await supabase
      .from("appointments")
      .insert({
        patient_id: patient.id,
        doctor_id: slot.doctorId,
        slot_date: slotDate,
        slot_time: slotTime,
        status: "booked",
        notes: ["Review", "Consultation", "Booked via review link"].join(" | "),
        booked_by: null,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const { data: doctor } = await supabase.from("doctors").select("name").eq("id", slot.doctorId).maybeSingle();
    await core.logForReception(supabase, "APPOINTMENT_CREATE",
      `Booked ${patient.name} for Review on ${core.displayDate(slotDate)} at ${core.displayTime(slotTime)}${doctor?.name ? ` with Dr. ${doctor.name}` : ""} via review link`);
    await core.sendConfirmation(supabase, { serviceRoleKey, canonicalPhone: phone, name: patient.name, doctorId: slot.doctorId, slotDate, slotTime, appointmentId: appointment.id });

    return core.json(200, {
      success: true,
      appointment_id: appointment.id,
      doctor_name: doctor?.name || null,
      patient_name: patient.name,
      date: slotDate,
      dateLabel: core.displayDate(slotDate, true),
      time: core.displayTime(slotTime),
    });
  } catch (error) {
    console.error("review-book error:", error.message);
    return core.json(500, { error: "Something went wrong. Please try again or call the clinic." });
  }
};

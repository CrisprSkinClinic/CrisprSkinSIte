// netlify/functions/public-book-appointment.js
//
// Books a website appointment into the AppointmentManager Supabase project so it shows on
// the clinic's staff board. Called by BookingCalendar.astro after the WhatsApp number is
// verified and the booker has chosen who the appointment is for.
//
// This endpoint is public, so every rule is enforced here:
//   - the phone's verification token must be valid (checked, not used up, so the booker can
//     book for another person or manage appointments within the same 30 minutes);
//   - an existing patient must be one registered on that phone; otherwise a new patient is
//     created on it (reusing one with the same name, so a retyped name isn't a duplicate);
//   - one appointment per patient per day (with the option to move the existing one), and
//     at most MAX_VISITS_PER_NUMBER_PER_DAY visits per number per day at this clinic;
//   - a returning patient (seen here before) is booked as a Review.
// The service-role key never leaves the server.

const core = require("./lib/booking-core.cjs");

const BOOKING_FOR_NOTES = { family: "Booked by family member", friend: "Booked by friend" };
const GENDERS = ["male", "female", "other"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return core.json(400, { error: "Invalid request body" });
  }

  const {
    phone,
    otpToken,
    // An existing patient chosen from "Patients on this number"…
    patientId,
    // …or a new person: prefix + first + last (patients.name is one column), optional DOB/gender.
    name,
    dob,
    gender,
    email,
    service,
    date,
    time,
    doctorId: requestedDoctorId,
    // Sent instead of doctorId for "no preference": the doctors free at this time.
    candidateDoctorIds,
    // true when the booker chose to move this patient's existing appointment that day.
    reschedule,
    // "self" (default), "family" or "friend": who the verified number's owner is booking for.
    bookingFor,
  } = payload || {};

  const missing = [];
  if (!phone) missing.push("phone");
  if (!otpToken) missing.push("otpToken (verify your WhatsApp number first)");
  if (!patientId && !String(name || "").trim()) missing.push("name");
  if (!service) missing.push("service");
  if (!date) missing.push("date");
  if (!time) missing.push("time");
  if (requestedDoctorId && !core.CLINIC_DOCTOR_IDS.includes(String(requestedDoctorId))) {
    return core.json(400, { success: false, error: "Unknown doctor." });
  }
  if (!requestedDoctorId && !(Array.isArray(candidateDoctorIds) && candidateDoctorIds.length > 0)) {
    missing.push("doctorId (or candidateDoctorIds for no-preference bookings)");
  }
  if (missing.length) return core.json(400, { error: `Missing required field(s): ${missing.join(", ")}` });
  const dobValue = dob ? String(dob) : null;
  if (dobValue && (!/^\d{4}-\d{2}-\d{2}$/.test(dobValue) || dobValue > core.clinicNow().date || dobValue < "1900-01-01")) {
    return core.json(400, { success: false, error: "Enter a valid date of birth." });
  }
  const genderValue = gender ? String(gender).toLowerCase() : null;
  if (genderValue && !GENDERS.includes(genderValue)) return core.json(400, { success: false, error: "Choose a valid gender." });

  const { supabase, serviceRoleKey, error: configError } = core.serviceClient();
  if (configError) return core.json(500, { error: configError });

  try {
    // ---- The requested slot must be bookable ----
    const slotDate = String(date);
    const slotTime = core.normalizeTime(String(time));
    const candidates = requestedDoctorId
      ? [requestedDoctorId]
      : core.shuffle(candidateDoctorIds.filter((id) => core.CLINIC_DOCTOR_IDS.includes(id)));
    const slot = await core.findAvailableDoctor(supabase, { slotDate, slotTime, candidates });
    if (slot.error) return core.json(409, { success: false, error: slot.error });
    const doctorId = slot.doctorId;

    // ---- The phone must be verified ----
    const canonicalPhone = core.canonicalIndianMobile(phone);
    if (!canonicalPhone) {
      return core.json(400, { success: false, error: "Enter a valid 10-digit Indian mobile number that uses WhatsApp." });
    }
    if (!(await core.tokenIsValid(supabase, canonicalPhone, otpToken))) {
      return core.json(400, { success: false, expired: true, error: "Your phone verification has expired. Please verify your WhatsApp number again." });
    }

    // ---- Who the appointment is for ----
    const onNumber = await core.patientsOnPhone(supabase, canonicalPhone);
    let patient = null;
    if (patientId) {
      patient = onNumber.find((p) => p.id === String(patientId)) || null;
      if (!patient) return core.json(403, { success: false, error: "That patient isn't registered on this number." });
    } else {
      patient = onNumber.find((p) => core.normalizeName(p.name) === core.normalizeName(name)) || null;
    }
    const patientName = patient ? patient.name : String(name).trim().replace(/\s+/g, " ");
    const past = patient ? await core.lastConsultationFor(supabase, patient.id) : null;
    const isReview = Boolean(past?.date);

    // ---- One appointment per patient per day (offer to move it) ----
    if (patient) {
      const sameDay = await core.appointmentOnDay(supabase, patient.id, slotDate);
      if (sameDay) {
        const bookedTime = core.displayTime(sameDay.slot_time);
        const withDoctor = sameDay.doctors?.name ? ` with Dr. ${sameDay.doctors.name}` : "";
        const blocked = core.changeBlockReason(sameDay);
        const already = `${patientName} already has an appointment on ${core.displayDate(slotDate)} at ${bookedTime}${withDoctor}. Only one appointment per person per day is allowed online`;
        if (!reschedule) {
          return core.json(409, {
            success: false,
            error: blocked ? `${already}. ${blocked}` : `${already}.`,
            existing: { id: sameDay.id, date: slotDate, time: bookedTime, doctorName: sameDay.doctors?.name || null },
            canReschedule: !blocked,
          });
        }
        if (blocked) return core.json(409, { success: false, error: blocked });

        // Update in place: the id is referenced by notifications, bills and clinical records.
        const { data: moved, error: moveError } = await supabase
          .from("appointments")
          .update({ doctor_id: doctorId, slot_time: slotTime, notes: core.appendNote(sameDay.notes, "Rescheduled via website") })
          .eq("id", sameDay.id)
          .eq("status", "booked")
          .select("id")
          .maybeSingle();
        if (moveError) throw moveError;
        if (!moved) return core.json(409, { success: false, error: "This appointment can't be changed online. Please call the clinic." });

        const { data: newDoctor } = await supabase.from("doctors").select("name").eq("id", doctorId).maybeSingle();
        await core.logForReception(supabase, "APPOINTMENT_RESCHEDULE",
          `${patientName} moved their ${slotDate} appointment from ${bookedTime}${withDoctor} to ${core.displayTime(slotTime)}${newDoctor?.name ? ` with Dr. ${newDoctor.name}` : ""} via website`);
        await core.sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name: patientName, doctorId, slotDate, slotTime, appointmentId: sameDay.id, noPreference: !requestedDoctorId });
        return core.json(200, {
          success: true, rescheduled: true, appointment_id: sameDay.id, from: bookedTime, to: core.displayTime(slotTime),
          appointment: { patientName, doctorName: newDoctor?.name || null, date: slotDate, dateLabel: core.displayDate(slotDate, true), time: core.displayTime(slotTime), service },
        });
      }
    }

    // ---- At most MAX_VISITS_PER_NUMBER_PER_DAY visits per number per day ----
    if ((await core.visitsOnDay(supabase, onNumber.map((p) => p.id), slotDate)) >= core.MAX_VISITS_PER_NUMBER_PER_DAY) {
      return core.json(409, { success: false, limitReached: true, error: core.dailyLimitMessage(slotDate) });
    }

    // ---- Create the patient if new ----
    let bookedPatientId = patient?.id;
    if (!bookedPatientId) {
      const { data: newPatientId, error: insertPatientError } = await supabase.rpc("insert_patient_encrypted", {
        p_name: patientName,
        p_phone: canonicalPhone.slice(2),
        p_dob: dobValue,
        p_gender: genderValue,
        p_address: null,
        p_is_registered: false,
      });
      if (insertPatientError) throw insertPatientError;
      bookedPatientId = newPatientId;
    }

    // patients has no email column, so it goes in the notes with the service. The first
    // " | " part is the visit type reception reads, so a review leads with "Review".
    const notesParts = isReview ? ["Review", service] : [service];
    if (email) notesParts.push(`Email: ${email}`);
    if (BOOKING_FOR_NOTES[bookingFor]) notesParts.push(BOOKING_FOR_NOTES[bookingFor]);
    if (!requestedDoctorId) notesParts.push("No doctor preference");
    notesParts.push("Booked via website self-service");

    const { data: appointment, error: insertAppointmentError } = await supabase
      .from("appointments")
      .insert({
        patient_id: bookedPatientId,
        doctor_id: doctorId,
        slot_date: slotDate,
        slot_time: slotTime,
        status: "booked",
        notes: notesParts.join(" | "),
        booked_by: null,
      })
      .select("id")
      .single();
    if (insertAppointmentError) throw insertAppointmentError;

    const { data: bookedDoctor } = await supabase.from("doctors").select("name").eq("id", doctorId).maybeSingle();
    await core.logForReception(supabase, "APPOINTMENT_CREATE",
      `Booked ${patientName}${patient ? "" : " (new patient)"} for ${isReview ? `Review · ${service}` : service} on ${core.displayDate(slotDate)} at ${core.displayTime(slotTime)}${bookedDoctor?.name ? ` with Dr. ${bookedDoctor.name}` : ""} via website${BOOKING_FOR_NOTES[bookingFor] ? ` (${BOOKING_FOR_NOTES[bookingFor].toLowerCase()})` : ""}`);

    // Best-effort: a failed WhatsApp confirmation never fails the booking.
    await core.sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name: patientName, doctorId, slotDate, slotTime, appointmentId: appointment.id, noPreference: !requestedDoctorId });
    return core.json(200, {
      success: true,
      appointment_id: appointment.id,
      appointment: {
        patientName,
        doctorName: bookedDoctor?.name || null,
        date: slotDate,
        dateLabel: core.displayDate(slotDate, true),
        time: core.displayTime(slotTime),
        service: isReview ? `Review · ${service}` : service,
      },
    });
  } catch (error) {
    console.error("public-book-appointment error:", error.message);
    return core.json(500, { error: "Something went wrong. Please try again or call the clinic." });
  }
};

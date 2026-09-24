// netlify/functions/public-book-appointment.js
//
// Public-facing function used by BookingCalendar.astro. Lets a patient
// self-book an appointment directly into the AppointmentManager Supabase
// project so the booking shows up on the real staff board.
//
// This endpoint is intentionally public, so all trust boundaries are enforced
// here: the phone must be verified by WhatsApp code (verify-booking-otp.js),
// a patient is identified by phone + name, and the service-role key never
// leaves the server.

const core = require("./lib/booking-core");

const BOOKING_FOR_NOTES = { family: "Booked by family member", friend: "Booked by friend" };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return core.json(400, { error: "Invalid request body" });
  }

  const {
    // prefix + first + last, joined by BookingCalendar.astro (patients.name is one column)
    name,
    phone,
    email,
    service,
    date,
    time,
    doctorId: requestedDoctorId,
    // Sent instead of doctorId for "no preference": the doctors the slot check
    // found free at this time. Re-verified and picked at random here.
    candidateDoctorIds,
    // One-time token from verify-booking-otp.js proving the booker verified this phone.
    otpToken,
    // "review" when the form greeted a returning patient. Only a hint: the
    // server re-checks the patient's history before labelling it.
    appointmentType,
    // true when the patient chose "Move it to this time" after being told they
    // already have an appointment that day.
    reschedule,
    // "self" (default), "family" or "friend": who the verified phone's owner is booking for.
    bookingFor,
  } = payload || {};

  const missing = [];
  if (!name) missing.push("name");
  if (!phone) missing.push("phone");
  if (!otpToken) missing.push("otpToken (verify your WhatsApp number first)");
  if (!service) missing.push("service");
  if (!date) missing.push("date");
  if (!time) missing.push("time");
  if (!requestedDoctorId && !(Array.isArray(candidateDoctorIds) && candidateDoctorIds.length > 0)) {
    missing.push("doctorId (or candidateDoctorIds for no-preference bookings)");
  }
  if (missing.length) return core.json(400, { error: `Missing required field(s): ${missing.join(", ")}` });

  const { supabase, serviceRoleKey, error: configError } = core.serviceClient();
  if (configError) return core.json(500, { error: configError });

  try {
    // ---- Validate the requested slot is actually bookable ----
    const slotDate = String(date);
    const slotTime = core.normalizeTime(String(time));
    const candidates = requestedDoctorId
      ? [requestedDoctorId]
      : core.shuffle(candidateDoctorIds.filter((id) => core.CLINIC_DOCTOR_IDS.includes(id)));
    const slot = await core.findAvailableDoctor(supabase, { slotDate, slotTime, candidates });
    if (slot.error) return core.json(409, { success: false, error: slot.error });
    const doctorId = slot.doctorId;

    // ---- Check the phone verification ----
    //
    // Only checked here; consumed below once the one-booking-per-day rule has
    // passed, so neither a taken slot nor a duplicate attempt burns it.
    const canonicalPhone = core.canonicalIndianMobile(phone);
    if (!canonicalPhone) {
      return core.json(400, { success: false, error: "Enter a valid 10-digit Indian mobile number that uses WhatsApp." });
    }
    const verificationExpired = () =>
      core.json(400, { success: false, error: "Your phone verification has expired. Please verify your WhatsApp number again." });
    if (!(await core.tokenIsValid(supabase, canonicalPhone, otpToken))) return verificationExpired();

    // ---- Find the patient ----
    //
    // Reuse an existing patient only when the name matches too: family members
    // share numbers, and a different name on the same number is a different
    // person, not a typo.
    const past = await core.lastConsultation(supabase, canonicalPhone, name);
    const isReview = appointmentType === "review" && Boolean(past?.date);

    // ---- One website booking per patient per day ----
    //
    // Only after verification, so the reply can't reveal someone else's
    // appointment. Family members on the same number are different patients.
    if (past?.patientId) {
      const sameDay = await core.appointmentOnDay(supabase, past.patientId, slotDate);
      if (sameDay) {
        const bookedTime = core.displayTime(sameDay.slot_time);
        const withDoctor = sameDay.doctors?.name ? ` with Dr. ${sameDay.doctors.name}` : "";
        const canReschedule = core.canChangeOnline(sameDay);
        const already = `You already have an appointment on ${core.displayDate(slotDate)} at ${bookedTime}${withDoctor}. Only one booking per day is allowed online`;

        if (!reschedule) {
          return core.json(409, {
            success: false,
            error: canReschedule ? `${already}.` : `${already} — please call the clinic to change it.`,
            existing: { date: slotDate, time: bookedTime, doctorName: sameDay.doctors?.name || null },
            canReschedule,
          });
        }
        if (!canReschedule) return core.json(409, { success: false, error: "This appointment can't be changed online. Please call the clinic." });
        if (!(await core.consumeToken(supabase, canonicalPhone, otpToken))) return verificationExpired();

        // Update in place: the appointment id is referenced by notifications,
        // bills and clinical records, so it must not be deleted and re-created.
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
          `${name} moved their ${slotDate} appointment from ${bookedTime}${withDoctor} to ${core.displayTime(slotTime)}${newDoctor?.name ? ` with Dr. ${newDoctor.name}` : ""} via website`);
        await core.sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name, doctorId, slotDate, slotTime, appointmentId: sameDay.id });
        return core.json(200, { success: true, rescheduled: true, appointment_id: sameDay.id, from: bookedTime, to: core.displayTime(slotTime) });
      }
    }

    if (!(await core.consumeToken(supabase, canonicalPhone, otpToken))) return verificationExpired();

    // ---- Create the patient if new ----
    let patientId = past?.patientId;
    if (!patientId) {
      const { data: newPatientId, error: insertPatientError } = await supabase.rpc("insert_patient_encrypted", {
        p_name: name,
        p_phone: canonicalPhone.slice(2),
        p_dob: null,
        p_gender: null,
        p_address: null,
        p_is_registered: false,
      });
      if (insertPatientError) throw insertPatientError;
      patientId = newPatientId;
    }

    // patients has no email column, so it goes in the notes with the service.
    // The first " | " part is the visit type reception's Today screen, filters
    // and payment categories read, so a review must lead with "Review".
    const notesParts = isReview ? ["Review", service] : [service];
    if (email) notesParts.push(`Email: ${email}`);
    if (BOOKING_FOR_NOTES[bookingFor]) notesParts.push(BOOKING_FOR_NOTES[bookingFor]);
    notesParts.push("Booked via website self-service");

    const { data: appointment, error: insertAppointmentError } = await supabase
      .from("appointments")
      .insert({
        patient_id: patientId,
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
      `Booked ${name}${past?.patientId ? "" : " (new patient)"} for ${isReview ? `Review · ${service}` : service} on ${core.displayDate(slotDate)} at ${core.displayTime(slotTime)}${bookedDoctor?.name ? ` with Dr. ${bookedDoctor.name}` : ""} via website${BOOKING_FOR_NOTES[bookingFor] ? ` (${BOOKING_FOR_NOTES[bookingFor].toLowerCase()})` : ""}`);

    // Best-effort: a failed WhatsApp confirmation never fails the booking.
    await core.sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name, doctorId, slotDate, slotTime, appointmentId: appointment.id });
    return core.json(200, { success: true, appointment_id: appointment.id });
  } catch (error) {
    console.error("public-book-appointment error:", error);
    return core.json(500, { error: error.message || "Something went wrong." });
  }
};

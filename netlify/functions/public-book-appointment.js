// netlify/functions/public-book-appointment.js
//
// Public-facing function used by BookingCalendar.astro. Lets a patient
// self-book an appointment directly into the AppointmentManager Supabase
// project (a different project from eye-clinic-site's own one) so the
// booking shows up on the real staff AppointmentBoard.
//
// Uses the service role key server-side (never exposed to the browser),
// since this needs to read/write across patients/appointments/slot_templates/
// schedule_overrides without being gated by RLS policies designed for
// authenticated staff roles. There is no password gate here -- unlike
// manage-bookings.js, this endpoint is intentionally public, so all trust
// boundaries are enforced by the validation logic below, not by auth.

const { lastConsultation } = require("./public-returning-patient");

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

// CRISPR Skin and Hair Clinic's three dermatology doctors -- used when a
// patient books without a doctor preference (candidateDoctorIds omitted
// or covers doctors we should re-verify against). Kept in sync with the
// same list in public-available-slots.js.
const CLINIC_DOCTOR_IDS = [
  "514ff136-ee45-4d49-89b5-d128d96aef62", // Karthik L
  "d5372165-fc7e-47e8-aee6-ce02e7fefc71", // Narayanan A
  "519dbd89-d3d9-4ee9-8923-5fabbe51cf2e", // Narayanan B
];

// Maps JS Date#getUTCDay() (0 = Sunday) to slot_templates.day_of_week enum values.
const DAY_OF_WEEK_BY_INDEX = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  // BookingCalendar.astro should concatenate prefix + firstName + lastName
  // into a single `name` string before calling this function -- patients.name
  // is one text column, so the split-name concept ends at the form layer.
  const {
    name,
    phone,
    email,
    service,
    date,
    time,
    doctorId: requestedDoctorId,
    // Sent instead of doctorId when the patient booked without a
    // preference -- the list of doctor IDs the availability check found
    // free at this exact slot (see public-available-slots.js's merged
    // "no preference" response). We re-verify and pick randomly among
    // these server-side, rather than trusting a doctor choice made
    // client-side or baked in at page-load time.
    candidateDoctorIds,
    // One-time token from verify-booking-otp.js proving the patient
    // verified this phone number with a WhatsApp code.
    otpToken,
    // "review" when the form greeted a returning patient. Only a hint: the
    // server re-checks the verified patient's history before labelling it.
    appointmentType,
    // true when the patient chose "Move it to this time" after being told they
    // already have an appointment that day.
    reschedule,
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
  if (missing.length) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Missing required field(s): ${missing.join(", ")}` }),
    };
  }

  if (!createClient) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server module @supabase/supabase-js failed to load." }),
    };
  }

  if (!SUPABASE_URL) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "APPOINTMENT_MANAGER_SUPABASE_URL environment variable is missing." }),
    };
  }

  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY environment variable is missing.",
      }),
    };
  }

  // Same no-op WebSocket shim as manage-bookings.js -- works around Node
  // 20's lack of native WebSocket support on Netlify's runtime, which
  // would otherwise crash Supabase's Realtime client on init.
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      constructor() {}
      close() {}
      send() {}
    };
  }

  const supabase = createClient(SUPABASE_URL, serviceRoleKey);

  try {
    // ---- Validate the requested slot is actually bookable ----

    const slotDate = String(date); // expected "YYYY-MM-DD"
    const slotTime = normalizeTime(String(time)); // expected "HH:MM" or "HH:MM:SS"
    const dayOfWeek = DAY_OF_WEEK_BY_INDEX[new Date(`${slotDate}T00:00:00Z`).getUTCDay()];

    if (!dayOfWeek || Number.isNaN(new Date(`${slotDate}T00:00:00Z`).getTime())) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid date." }) };
    }

    // Candidates to try, in the order we'll attempt to book them. A single
    // requested doctorId is tried alone (existing behavior, unchanged).
    // For no-preference bookings, we shuffle the candidates so which
    // doctor gets the booking isn't determined by array order or any
    // other predictable rule -- genuine randomness, decided here on the
    // server rather than by the client.
    const candidates = requestedDoctorId
      ? [requestedDoctorId]
      : shuffle(candidateDoctorIds.filter((id) => CLINIC_DOCTOR_IDS.includes(id)));

    if (candidates.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "No valid doctor candidates provided." }) };
    }

    let doctorId = null;
    let validWindow = null;
    let maxPerSlot = 1;
    let lastFailureReason = "The selected time is outside available hours.";

    for (const candidateId of candidates) {
      const { data: overrides, error: overridesError } = await supabase
        .from("schedule_overrides")
        .select("*")
        .eq("doctor_id", candidateId)
        .eq("override_date", slotDate);
      if (overridesError) throw overridesError;

      if ((overrides || []).some((o) => o.override_type === "leave")) {
        lastFailureReason = "The selected doctor is not available on the selected date.";
        continue;
      }

      if ((overrides || []).some((o) => o.override_type === "blocked_slot" && o.blocked_slot === slotTime)) {
        lastFailureReason = "That time slot is unavailable on the selected date.";
        continue;
      }

      const modifiedOverride = (overrides || []).find((o) => o.override_type === "modified");

      let candidateWindow = null;
      let candidateMaxPerSlot = 1;

      if (modifiedOverride) {
        if (
          modifiedOverride.modified_start &&
          modifiedOverride.modified_end &&
          slotTime >= normalizeTime(modifiedOverride.modified_start) &&
          slotTime < normalizeTime(modifiedOverride.modified_end)
        ) {
          candidateWindow = modifiedOverride;
        }
      } else {
        const { data: templates, error: templatesError } = await supabase
          .from("slot_templates")
          .select("*")
          .eq("doctor_id", candidateId)
          .eq("day_of_week", dayOfWeek)
          .eq("is_active", true);
        if (templatesError) throw templatesError;

        const matchingTemplate = (templates || []).find(
          (t) => slotTime >= normalizeTime(t.session_start) && slotTime < normalizeTime(t.session_end)
        );

        if (matchingTemplate) {
          candidateWindow = matchingTemplate;
          candidateMaxPerSlot = matchingTemplate.max_per_slot || 1;
        }
      }

      if (!candidateWindow) continue;

      const { count: existingCount, error: countError } = await supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("doctor_id", candidateId)
        .eq("slot_date", slotDate)
        .eq("slot_time", slotTime)
        .not("status", "in", "(cancelled)");
      if (countError) throw countError;

      if ((existingCount || 0) >= candidateMaxPerSlot) {
        lastFailureReason = "That time slot is already fully booked.";
        continue;
      }

      // This candidate is genuinely available -- use it.
      doctorId = candidateId;
      validWindow = candidateWindow;
      maxPerSlot = candidateMaxPerSlot;
      break;
    }

    if (!doctorId) {
      return ok({ success: false, error: lastFailureReason }, 409);
    }

    // ---- Check the phone verification ----
    //
    // Runs after the slot is confirmed free. The token is only checked here and
    // consumed below, once the one-booking-per-day rule has passed, so neither a
    // taken slot nor a duplicate attempt burns the patient's verification.
    // Service_role-only RPCs: the token must belong to this phone, be unused,
    // and be under 30 minutes old.
    const canonicalPhone = canonicalIndianMobile(phone);
    if (!canonicalPhone) {
      return ok({ success: false, error: "Enter a valid 10-digit Indian mobile number that uses WhatsApp." }, 400);
    }
    const verificationExpired = () =>
      ok({ success: false, error: "Your phone verification has expired. Please verify your WhatsApp number again." }, 400);
    const { data: tokenLooksValid, error: peekError } = await supabase.rpc("service_peek_phone_otp_token", {
      p_phone: canonicalPhone,
      p_token: String(otpToken),
    });
    if (peekError) {
      if (/uuid/i.test(peekError.message || "")) return verificationExpired();
      throw peekError;
    }
    if (!tokenLooksValid) return verificationExpired();

    // ---- Find the patient ----
    //
    // patients.name/phone are encrypted, so lookup goes through a hash-matching
    // RPC and inserts through insert_patient_encrypted. Reuse an existing patient
    // only when the name matches too: family members share numbers, and a
    // different name on the same number is a different person, not a typo.
    const past = await lastConsultation(supabase, canonicalPhone, name);
    const isReview = appointmentType === "review" && Boolean(past?.date);

    // ---- One website booking per patient per day ----
    //
    // Only after verification, so the reply can't be used to learn someone
    // else's appointment. Family members on the same number are different
    // patients and can still book the same day.
    if (past?.patientId) {
      const { data: sameDay, error: sameDayError } = await supabase
        .from("appointments")
        .select("id, slot_time, status, linked_group_id, doctor_id, notes, doctors(name)")
        .eq("patient_id", past.patientId)
        .eq("slot_date", slotDate)
        .neq("status", "cancelled")
        .is("deleted_at", null)
        .order("slot_time", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (sameDayError) throw sameDayError;
      if (sameDay) {
        const displayDay = new Date(`${slotDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
        const bookedTime = displayTime(sameDay.slot_time);
        const withDoctor = sameDay.doctors?.name ? ` with Dr. ${sameDay.doctors.name}` : "";
        // Online moves are limited to a plain single-slot booking the patient
        // hasn't arrived for yet; anything else is reception's to change.
        const canReschedule = sameDay.status === "booked" && !sameDay.linked_group_id;

        if (!reschedule) {
          return ok({
            success: false,
            error: canReschedule
              ? `You already have an appointment on ${displayDay} at ${bookedTime}${withDoctor}. Only one booking per day is allowed online.`
              : `You already have an appointment on ${displayDay} at ${bookedTime}${withDoctor}. Only one booking per day is allowed online — please call the clinic to change it.`,
            existing: { date: slotDate, time: bookedTime, doctorName: sameDay.doctors?.name || null },
            canReschedule,
          }, 409);
        }
        if (!canReschedule) {
          return ok({ success: false, error: "This appointment can't be changed online. Please call the clinic." }, 409);
        }

        const { data: moveConsumed, error: moveConsumeError } = await supabase.rpc("service_consume_phone_otp_token", {
          p_phone: canonicalPhone,
          p_token: String(otpToken),
        });
        if (moveConsumeError) throw moveConsumeError;
        if (!moveConsumed) return verificationExpired();

        // Update in place: the appointment id is referenced by notifications,
        // bills and clinical records, so it must not be deleted and re-created.
        const movedNote = String(sameDay.notes || "").includes("Rescheduled via website")
          ? sameDay.notes
          : [sameDay.notes, "Rescheduled via website"].filter(Boolean).join(" | ");
        const { data: moved, error: moveError } = await supabase
          .from("appointments")
          .update({ doctor_id: doctorId, slot_time: slotTime, notes: movedNote })
          .eq("id", sameDay.id)
          .eq("status", "booked")
          .select("id")
          .maybeSingle();
        if (moveError) throw moveError;
        if (!moved) return ok({ success: false, error: "This appointment can't be changed online. Please call the clinic." }, 409);

        const { data: newDoctor } = await supabase.from("doctors").select("name").eq("id", doctorId).maybeSingle();
        const { error: auditError } = await supabase.from("booking_audit_log").insert({
          action: "RESCHEDULE",
          details: `${name} moved their ${slotDate} appointment from ${bookedTime}${withDoctor} to ${displayTime(slotTime)}${newDoctor?.name ? ` with Dr. ${newDoctor.name}` : ""} via website`,
          performed_by: "Website (patient)",
        });
        if (auditError) console.error("Reschedule audit log failed:", auditError.message);

        await sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name, doctorId, slotDate, slotTime, appointmentId: sameDay.id });
        return ok({ success: true, rescheduled: true, appointment_id: sameDay.id, from: bookedTime, to: displayTime(slotTime) });
      }
    }

    const { data: tokenConsumed, error: consumeError } = await supabase.rpc("service_consume_phone_otp_token", {
      p_phone: canonicalPhone,
      p_token: String(otpToken),
    });
    if (consumeError) throw consumeError;
    if (!tokenConsumed) return verificationExpired();

    // ---- Create the patient if new ----

    let patientId;
    if (past?.patientId) {
      patientId = past.patientId;
    } else {
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

    // patients has no email column, so it's folded into the appointment
    // notes alongside the selected service -- same free-text approach
    // already used for service, since there's no dedicated column for it.
    // The first " | " part is the visit type reception's Today screen, filters and
    // payment categories read, so a review must lead with "Review".
    const notesParts = isReview ? ["Review", service] : [service];
    if (email) notesParts.push(`Email: ${email}`);
    notesParts.push("Booked via website self-service");
    const notes = notesParts.join(" | ");

    // ---- Create the appointment ----

    const { data: appointment, error: insertAppointmentError } = await supabase
      .from("appointments")
      .insert({
        patient_id: patientId,
        doctor_id: doctorId,
        slot_date: slotDate,
        slot_time: slotTime,
        status: "booked",
        notes,
        booked_by: null,
      })
      .select("id")
      .single();
    if (insertAppointmentError) throw insertAppointmentError;

    // Best-effort: a failed WhatsApp confirmation never fails the booking.
    await sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name, doctorId, slotDate, slotTime, appointmentId: appointment.id });

    return ok({ success: true, appointment_id: appointment.id });
  } catch (error) {
    console.error("public-book-appointment error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Something went wrong.",
        debug: { name: error.name, stack: error.stack?.split("\n").slice(0, 3) },
      }),
    };
  }
};

// Normalizes time input to "HH:MM:SS" (24-hour) for consistent string
// comparison against Postgres `time` columns. Accepts:
//   - "HH:MM" / "HH:MM:SS" (24-hour, e.g. from schedule_overrides/slot_templates rows)
//   - "h:mm AM/PM" / "hh:mm AM/PM" (12-hour display strings, e.g. BookingCalendar.astro's
//     selectedTime, which comes from generateSlotsForSession as "09:30 AM")
// "13:30:00" -> "1:30 PM"
function displayTime(t) {
  const [hh, mm] = String(t).split(":");
  const hour = parseInt(hh, 10);
  return `${((hour + 11) % 12) + 1}:${mm} ${hour >= 12 ? "PM" : "AM"}`;
}

// Sends the approved WhatsApp appointment confirmation through the
// send-wa-appointment-confirmation Edge Function (Meta credentials stay in
// Supabase). Best-effort: failures are logged, never thrown, because the
// booking itself has already succeeded.
async function sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name, doctorId, slotDate, slotTime, appointmentId }) {
  try {
    const { data: doctorRow, error: doctorLookupError } = await supabase.from("doctors").select("name").eq("id", doctorId).single();
    if (doctorLookupError) throw doctorLookupError;
    const displayDate = new Date(`${slotDate}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-wa-appointment-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceRoleKey}` },
      body: JSON.stringify({
        phone: canonicalPhone,
        patient_name: name,
        doctor_name: doctorRow?.name ? `Dr. ${doctorRow.name}` : "your doctor",
        date: displayDate,
        time: displayTime(slotTime),
        appointment_id: appointmentId,
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error("WhatsApp confirmation send failed:", errBody.error || res.status);
    }
  } catch (whatsappError) {
    console.error("WhatsApp confirmation send threw:", whatsappError.message);
  }
}

// Must match send-booking-otp.js / verify-booking-otp.js: codes are stored against a hash of this exact form.
function canonicalIndianMobile(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : null;
}

function normalizeTime(t) {
  if (!t) return t;

  const ampmMatch = t.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (ampmMatch) {
    let [, hours, minutes, meridiem] = ampmMatch;
    hours = parseInt(hours, 10);
    if (meridiem.toUpperCase() === "PM" && hours !== 12) hours += 12;
    if (meridiem.toUpperCase() === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:${minutes}:00`;
  }

  return t.length === 5 ? `${t}:00` : t;
}

function ok(body, statusCode = 200) {
  return { statusCode, body: JSON.stringify(body) };
}

// Fisher-Yates shuffle -- used to randomize which doctor a no-preference
// booking is tried against first, so doctor assignment isn't biased by
// array order (e.g. always trying Karthik first because he's listed
// first in CLINIC_DOCTOR_IDS).
function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

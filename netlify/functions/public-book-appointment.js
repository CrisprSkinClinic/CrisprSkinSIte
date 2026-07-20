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

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

// Dr. Rajeswari is currently the only doctor accepting public bookings.
// Confirmed via direct query against AppointmentManager's `doctors` table
// (2026-06-29) -- there is a second doctor row (Karthik L) in the table,
// so this is a deliberate hardcode of the one doctor open to self-service
// booking, not an assumption that she's the only row.
const DOCTOR_ID = "5523d5a2-855c-46a5-9bda-04a1f1563d38";

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
  const { name, phone, email, service, date, time } = payload || {};

  const missing = [];
  if (!name) missing.push("name");
  if (!phone) missing.push("phone");
  if (!service) missing.push("service");
  if (!date) missing.push("date");
  if (!time) missing.push("time");
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

    const { data: overrides, error: overridesError } = await supabase
      .from("schedule_overrides")
      .select("*")
      .eq("doctor_id", DOCTOR_ID)
      .eq("override_date", slotDate);
    if (overridesError) throw overridesError;

    if ((overrides || []).some((o) => o.override_type === "leave")) {
      return ok({ success: false, error: "Dr. Rajeswari is not available on the selected date." }, 409);
    }

    if ((overrides || []).some((o) => o.override_type === "blocked_slot" && o.blocked_slot === slotTime)) {
      return ok({ success: false, error: "That time slot is unavailable on the selected date." }, 409);
    }

    const modifiedOverride = (overrides || []).find((o) => o.override_type === "modified");

    let validWindow = null;
    let maxPerSlot = 1;

    if (modifiedOverride) {
      // A modified override replaces the normal template window for this date.
      if (
        modifiedOverride.modified_start &&
        modifiedOverride.modified_end &&
        slotTime >= normalizeTime(modifiedOverride.modified_start) &&
        slotTime < normalizeTime(modifiedOverride.modified_end)
      ) {
        validWindow = modifiedOverride;
      }
    } else {
      const { data: templates, error: templatesError } = await supabase
        .from("slot_templates")
        .select("*")
        .eq("doctor_id", DOCTOR_ID)
        .eq("day_of_week", dayOfWeek)
        .eq("is_active", true);
      if (templatesError) throw templatesError;

      const matchingTemplate = (templates || []).find(
        (t) => slotTime >= normalizeTime(t.session_start) && slotTime < normalizeTime(t.session_end)
      );

      if (matchingTemplate) {
        validWindow = matchingTemplate;
        maxPerSlot = matchingTemplate.max_per_slot || 1;
      }
    }

    if (!validWindow) {
      return ok({ success: false, error: "The selected time is outside available hours." }, 409);
    }

    const { count: existingCount, error: countError } = await supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("doctor_id", DOCTOR_ID)
      .eq("slot_date", slotDate)
      .eq("slot_time", slotTime)
      .not("status", "in", "(cancelled)");
    if (countError) throw countError;

    if ((existingCount || 0) >= maxPerSlot) {
      return ok({ success: false, error: "That time slot is already fully booked." }, 409);
    }

    // ---- Find or create the patient ----

    const { data: existingPatients, error: patientLookupError } = await supabase
      .from("patients")
      .select("id")
      .eq("phone", phone)
      .limit(1);
    if (patientLookupError) throw patientLookupError;

    let patientId;
    if (existingPatients && existingPatients.length > 0) {
      patientId = existingPatients[0].id;
    } else {
      const { data: newPatient, error: insertPatientError } = await supabase
        .from("patients")
        .insert({ name, phone, is_registered: false })
        .select("id")
        .single();
      if (insertPatientError) throw insertPatientError;
      patientId = newPatient.id;
    }

    // patients has no email column, so it's folded into the appointment
    // notes alongside the selected service -- same free-text approach
    // already used for service, since there's no dedicated column for it.
    const notesParts = [service];
    if (email) notesParts.push(`Email: ${email}`);
    notesParts.push("Booked via website self-service");
    const notes = notesParts.join(" | ");

    // ---- Create the appointment ----

    const { data: appointment, error: insertAppointmentError } = await supabase
      .from("appointments")
      .insert({
        patient_id: patientId,
        doctor_id: DOCTOR_ID,
        slot_date: slotDate,
        slot_time: slotTime,
        status: "booked",
        notes,
        booked_by: null,
      })
      .select("id")
      .single();
    if (insertAppointmentError) throw insertAppointmentError;

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

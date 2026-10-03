// netlify/functions/public-available-slots.js
//
// Read-side counterpart to public-book-appointment.js. BookingCalendar.astro
// calls this to find out which slots are actually bookable for a given
// date, instead of querying schedule_sessions/blocked_dates/blocked_slots
// (eye-clinic-site's own, now-stale tables) or AppointmentManager's tables
// directly via an anon key. Uses the same service role key as
// public-book-appointment.js rather than opening a new public RLS read
// path on slot_templates/schedule_overrides/appointments, given this
// database's RLS audit history.
//
// Availability comes from the database (service_public_available_starts), the same grid the
// booking function and the receptionist app use, so a time shown here is a time the booking
// step will accept. New consultations only list starts where the same doctor is free for the
// whole 30 minutes; unassigned ("any doctor") reception bookings and soft-deleted rows are
// accounted for by the database.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

// CRISPR Skin and Hair Clinic's three dermatology doctors. Used to fan out
// availability across all three when a patient books without a doctor
// preference, rather than silently defaulting to any one of them.
const CLINIC_DOCTOR_IDS = [
  "514ff136-ee45-4d49-89b5-d128d96aef62", // Karthik L
  "d5372165-fc7e-47e8-aee6-ce02e7fefc71", // Narayanan A
  "519dbd89-d3d9-4ee9-8923-5fabbe51cf2e", // Narayanan B
];

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const date =
    event.httpMethod === "GET"
      ? event.queryStringParameters && event.queryStringParameters.date
      : safeParse(event.body)?.date;

  // doctorId is intentionally optional. When omitted, we fan out across
  // all three dermatology doctors and return combined slots -- this is
  // the "no preference" path for new patients, and it's genuinely
  // unbiased (every doctor's real availability is shown) rather than
  // silently picking one doctor on the patient's behalf.
  const requestedDoctorId =
    (event.httpMethod === "GET"
      ? event.queryStringParameters && event.queryStringParameters.doctorId
      : safeParse(event.body)?.doctorId) || null;
  const appointmentType =
    (event.httpMethod === "GET"
      ? event.queryStringParameters && event.queryStringParameters.appointmentType
      : safeParse(event.body)?.appointmentType) || "new";
  if (requestedDoctorId && !CLINIC_DOCTOR_IDS.includes(requestedDoctorId)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Unknown doctor." }) };
  }

  if (!date) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required field: date" }) };
  }

  // A follow-up (review) is always with a named doctor; "no preference" is only for a new consultation.
  if (String(appointmentType).toLowerCase() === "review" && !requestedDoctorId) {
    return { statusCode: 200, body: JSON.stringify({ slots: [], reason: "Choose a doctor for your follow-up visit." }) };
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

  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      constructor() {}
      close() {}
      send() {}
    };
  }

  const supabase = createClient(SUPABASE_URL, serviceRoleKey);

  const slotDate = String(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || Number.isNaN(new Date(`${slotDate}T00:00:00Z`).getTime())) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid date." }) };
  }

  try {
    const doctorIdsToCheck = requestedDoctorId ? [requestedDoctorId] : CLINIC_DOCTOR_IDS;
    const isNew = String(appointmentType).toLowerCase() !== "review";
    const { data, error } = await supabase.rpc("service_public_available_starts", {
      p_date: slotDate,
      p_doctor_ids: doctorIdsToCheck,
      p_is_new: isNew,
    });
    if (error) throw error;

    const starts = (data || []).map((row) => ({
      time24: String(row.slot_time).slice(0, 5),
      doctorIds: row.doctor_ids || [],
    }));
    const reason = starts.length
      ? undefined
      : requestedDoctorId
        ? "No slots are available for the selected doctor on the selected date."
        : "No sessions scheduled with any doctor on the selected date.";

    if (requestedDoctorId) {
      return ok({ slots: starts.map(({ time24 }) => ({ time24, display: to12Hour(time24) })), ...(reason ? { reason } : {}) });
    }
    // No preference: each start lists the doctors free for the whole visit; the booking step
    // re-checks and assigns one of them.
    return ok({ slots: starts.map((s) => ({ ...s, display: to12Hour(s.time24) })), ...(reason ? { reason } : {}) });
  } catch (error) {
    console.error("public-available-slots error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Something went wrong.",
        debug: { name: error.name, stack: error.stack?.split("\n").slice(0, 3) },
      }),
    };
  }
};

function safeParse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// "14:30" -> "02:30 PM", matching the display format BookingCalendar.astro renders.
function to12Hour(time24) {
  const [h, m] = time24.split(":").map(Number);
  const meridiem = h >= 12 ? "PM" : "AM";
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${meridiem}`;
}

function ok(body, statusCode = 200) {
  return { statusCode, body: JSON.stringify(body) };
}

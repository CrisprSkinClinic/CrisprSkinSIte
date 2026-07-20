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
// The slot-generation and override logic here intentionally mirrors
// public-book-appointment.js's validation logic -- a slot returned as
// "available" here must also pass validation there, or bookings will
// fail at submit time despite being shown as open.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

// Same doctor as public-book-appointment.js -- see that file for context
// on why this is a deliberate hardcode, not an assumption she's the only doctor.
const DOCTOR_ID = "5523d5a2-855c-46a5-9bda-04a1f1563d38";

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
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const date =
    event.httpMethod === "GET"
      ? event.queryStringParameters && event.queryStringParameters.date
      : safeParse(event.body)?.date;

  if (!date) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required field: date" }) };
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

  try {
    // Read the doctor's current slot duration live -- this used to be a
    // hardcoded constant, which meant changing it in AppointmentManager's
    // doctors table had no effect on the website until someone noticed and
    // redeployed. Querying it here means it's always in sync.
    const { data: doctorRow, error: doctorError } = await supabase
      .from("doctors")
      .select("slot_duration_mins")
      .eq("id", DOCTOR_ID)
      .single();
    if (doctorError) throw doctorError;
    const slotDurationMins = doctorRow?.slot_duration_mins || 30;

    const slotDate = String(date);
    const parsedDate = new Date(`${slotDate}T00:00:00Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid date." }) };
    }
    const dayOfWeek = DAY_OF_WEEK_BY_INDEX[parsedDate.getUTCDay()];

    const { data: overrides, error: overridesError } = await supabase
      .from("schedule_overrides")
      .select("*")
      .eq("doctor_id", DOCTOR_ID)
      .eq("override_date", slotDate);
    if (overridesError) throw overridesError;

    if ((overrides || []).some((o) => o.override_type === "leave")) {
      return ok({ slots: [], reason: "Dr. Rajeswari is not available on the selected date." });
    }

    const blockedTimes = new Set(
      (overrides || []).filter((o) => o.override_type === "blocked_slot").map((o) => o.blocked_slot)
    );

    const modifiedOverride = (overrides || []).find((o) => o.override_type === "modified");

    let windows = [];
    let maxPerSlotByWindow = new Map();

    if (modifiedOverride && modifiedOverride.modified_start && modifiedOverride.modified_end) {
      windows = [{ session_start: modifiedOverride.modified_start, session_end: modifiedOverride.modified_end }];
    } else {
      const { data: templates, error: templatesError } = await supabase
        .from("slot_templates")
        .select("*")
        .eq("doctor_id", DOCTOR_ID)
        .eq("day_of_week", dayOfWeek)
        .eq("is_active", true)
        .order("session_start", { ascending: true });
      if (templatesError) throw templatesError;

      windows = templates || [];
      windows.forEach((w) => maxPerSlotByWindow.set(w, w.max_per_slot || 1));
    }

    if (windows.length === 0) {
      return ok({ slots: [], reason: "No sessions scheduled on the selected date." });
    }

    // Generate discrete slot start times across each window at the doctor's slot duration.
    const candidateTimes = [];
    for (const w of windows) {
      const maxPerSlot = maxPerSlotByWindow.get(w) || 1;
      let cursor = timeToMinutes(w.session_start);
      const end = timeToMinutes(w.session_end);
      while (cursor < end) {
        candidateTimes.push({ time24: minutesToTime(cursor), maxPerSlot });
        cursor += slotDurationMins;
      }
    }

    // Existing non-cancelled appointment counts per time, for this doctor/date.
    const { data: existingAppointments, error: appointmentsError } = await supabase
      .from("appointments")
      .select("slot_time")
      .eq("doctor_id", DOCTOR_ID)
      .eq("slot_date", slotDate)
      .not("status", "in", "(cancelled)");
    if (appointmentsError) throw appointmentsError;

    const bookedCounts = {};
    for (const row of existingAppointments || []) {
      bookedCounts[row.slot_time] = (bookedCounts[row.slot_time] || 0) + 1;
    }

    const slots = candidateTimes
      .filter(({ time24 }) => !blockedTimes.has(time24) && !blockedTimes.has(`${time24}:00`))
      .filter(({ time24, maxPerSlot }) => (bookedCounts[`${time24}:00`] || bookedCounts[time24] || 0) < maxPerSlot)
      .sort((a, b) => timeToMinutes(a.time24) - timeToMinutes(b.time24))
      .map(({ time24 }) => ({ time24, display: to12Hour(time24) }));

    return ok({ slots });
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

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "14:30" -> "02:30 PM", matching the display format BookingCalendar.astro
// already renders via generateSlotsForSession, so its rendering code
// doesn't need to change -- just its data source.
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

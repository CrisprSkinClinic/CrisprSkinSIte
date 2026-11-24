// netlify/functions/public-availability-range.js
//
// Batch counterpart to public-available-slots.js: returns every doctor's open
// times for a run of dates in ONE request (4 parallel queries in total), so
// the booking form can show dates and times from memory instead of making one
// slow request per date. The slot logic mirrors public-available-slots.js:
//
//   times  = the single-slot ("review") openings for that doctor/day
//   a "new" patient needs two back-to-back 15-minute slots, which the client
//   derives from `times` (time + 15 minutes must also be open).
//
// Times that have already passed today are NOT removed here, so the response
// can be cached and shared; the client drops them using the IST clock.
// Booking itself is still validated server-side in public-book-appointment.js.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const CLINIC_DOCTOR_IDS = [
  "514ff136-ee45-4d49-89b5-d128d96aef62", // Karthik L
  "d5372165-fc7e-47e8-aee6-ce02e7fefc71", // Narayanan A
  "519dbd89-d3d9-4ee9-8923-5fabbe51cf2e", // Narayanan B
];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MAX_DAYS = 62;
const TTL_MS = 15000;

// Warm-instance cache: many visitors within a few seconds share one database round trip.
const memo = new Map(); // `${from}|${days}` -> { at, body }

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method Not Allowed" };
  const qs = event.queryStringParameters || {};
  const from = String(qs.from || "");
  const days = Math.min(Math.max(parseInt(qs.days, 10) || 30, 1), MAX_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(new Date(`${from}T00:00:00Z`).getTime())) {
    return json(400, { error: "Invalid from date." });
  }

  const key = `${from}|${days}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return respond(hit.body);

  const url = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
  const serviceKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient || !url || !serviceKey) return json(500, { error: "Availability service is not configured." });
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }
  const supabase = createClient(url, serviceKey);

  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const to = dates[dates.length - 1];

  try {
    const [doctorsRes, overridesRes, templatesRes, apptsRes] = await Promise.all([
      supabase.from("doctors").select("id, slot_duration_mins").in("id", CLINIC_DOCTOR_IDS),
      supabase.from("schedule_overrides").select("*").in("doctor_id", CLINIC_DOCTOR_IDS).gte("override_date", from).lte("override_date", to),
      supabase.from("slot_templates").select("*").in("doctor_id", CLINIC_DOCTOR_IDS).eq("is_active", true).order("session_start", { ascending: true }),
      supabase.from("appointments").select("doctor_id, slot_date, slot_time").in("doctor_id", CLINIC_DOCTOR_IDS).gte("slot_date", from).lte("slot_date", to).not("status", "in", "(cancelled)"),
    ]);
    for (const r of [doctorsRes, overridesRes, templatesRes, apptsRes]) if (r.error) throw r.error;

    const duration = new Map((doctorsRes.data || []).map((d) => [d.id, d.slot_duration_mins || 30]));
    const out = {};
    for (const date of dates) {
      const dow = DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
      out[date] = {};
      for (const id of CLINIC_DOCTOR_IDS) {
        const overrides = (overridesRes.data || []).filter((o) => o.doctor_id === id && o.override_date === date);
        if (overrides.some((o) => o.override_type === "leave")) {
          out[date][id] = { times: [], reason: "The selected doctor is not available on the selected date." };
          continue;
        }
        const blocked = new Set(overrides.filter((o) => o.override_type === "blocked_slot").map((o) => o.blocked_slot));
        const modified = overrides.find((o) => o.override_type === "modified");
        let windows;
        if (modified && modified.modified_start && modified.modified_end) {
          windows = [{ session_start: modified.modified_start, session_end: modified.modified_end, max_per_slot: 1 }];
        } else {
          windows = (templatesRes.data || []).filter((t) => t.doctor_id === id && t.day_of_week === dow);
        }
        if (!windows.length) {
          out[date][id] = { times: [], reason: "No sessions scheduled on the selected date." };
          continue;
        }
        const booked = {};
        for (const a of apptsRes.data || []) {
          if (a.doctor_id === id && a.slot_date === date) booked[a.slot_time] = (booked[a.slot_time] || 0) + 1;
        }
        const step = duration.get(id) || 30;
        const times = new Set();
        for (const w of windows) {
          const max = w.max_per_slot || 1;
          for (let c = toMin(w.session_start), end = toMin(w.session_end); c < end; c += step) {
            const t = fromMin(c);
            if (blocked.has(t) || blocked.has(`${t}:00`)) continue;
            if ((booked[`${t}:00`] || booked[t] || 0) >= max) continue;
            times.add(t);
          }
        }
        out[date][id] = { times: Array.from(times).sort(), reason: "" };
      }
    }

    const body = { from, days, generatedAt: Date.now(), data: out };
    memo.set(key, { at: Date.now(), body });
    return respond(body);
  } catch (error) {
    console.error("public-availability-range error:", error);
    return json(500, { error: error.message || "Something went wrong." });
  }
};

function respond(body) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      // Shared cache: serve instantly, refresh in the background.
      "Cache-Control": "public, max-age=0, s-maxage=20, stale-while-revalidate=120",
    },
    body: JSON.stringify(body),
  };
}
function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function toMin(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}
function fromMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

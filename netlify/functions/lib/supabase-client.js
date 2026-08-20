// netlify/functions/lib/supabase-client.js
//
// Shared service-role Supabase client creation for all bookings-manager
// modules. Centralized here so the WebSocket shim (needed because
// Netlify's Node runtime doesn't provide a global WebSocket, which the
// supabase-js realtime client otherwise expects) and env var checks
// only need to exist once.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;

function ensureWebSocketShim() {
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      constructor() {}
      close() {}
      send() {}
    };
  }
}

// Returns { supabase } on success, or { errorResponse } if the module
// or env vars aren't available -- callers check errorResponse first.
function createServiceRoleClient() {
  if (!createClient) {
    return { errorResponse: { statusCode: 500, body: JSON.stringify({ error: "Server module @supabase/supabase-js failed to load." }) } };
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { errorResponse: { statusCode: 500, body: JSON.stringify({ error: "Supabase environment variables are missing." }) } };
  }
  ensureWebSocketShim();
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  return { supabase };
}

function ok(body, statusCode = 200) {
  return { statusCode, body: JSON.stringify(body) };
}

// Sends the WhatsApp appointment_confirmation template via the
// send-wa-appointment-confirmation Supabase Edge Function, using the
// same service-role credential this module already holds for its own
// Supabase calls (no new secret needed -- see that function's own
// comments for why it verifies the token by using it, rather than
// comparing it directly against Deno's auto-injected
// SUPABASE_SERVICE_ROLE_KEY, which turned out to be a different,
// shorter-format key than this one on this project).
//
// Deliberately fire-and-forget from the caller's perspective: never
// throws, only logs -- a booking must succeed regardless of whether
// the confirmation message goes out.
async function sendAppointmentConfirmation({ phone, patientName, doctorName, date, time, appointmentId }) {
  if (!phone) {
    console.error("Skipping WhatsApp confirmation: no phone on file for this booking.");
    return;
  }
  try {
    const bare = String(phone).replace(/^\+/, "");
    const sendPhone = bare.length === 10 ? `91${bare}` : bare;

    const displayDate = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    const [hh, mm] = String(time).split(":");
    const hourNum = parseInt(hh, 10);
    const displayTime = `${((hourNum + 11) % 12) + 1}:${mm} ${hourNum >= 12 ? "PM" : "AM"}`;

    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-wa-appointment-confirmation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        phone: sendPhone,
        patient_name: patientName,
        doctor_name: doctorName ? `Dr. ${doctorName}` : "your doctor",
        date: displayDate,
        time: displayTime,
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

module.exports = { createServiceRoleClient, ok, sendAppointmentConfirmation };

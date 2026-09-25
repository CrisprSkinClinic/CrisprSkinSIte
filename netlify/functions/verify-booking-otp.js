// netlify/functions/verify-booking-otp.js
//
// Checks the WhatsApp code the patient typed into BookingCalendar.astro and,
// if it matches, returns a verification token. The booking page and its functions
// accept it for that phone for 30 minutes after verification (not used up by a booking),
// so the patient verifies once and can still pick another slot if theirs is taken.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const { canonicalIndianMobile } = require("./lib/booking-core.cjs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let phone, code;
  try {
    ({ phone, code } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { error: "Invalid request body" });
  }

  const canonical = canonicalIndianMobile(phone);
  const digits = String(code || "").replace(/\D/g, "");
  if (!canonical) return json(400, { error: "Enter a valid 10-digit Indian mobile number that uses WhatsApp." });
  if (digits.length !== 6) return json(400, { error: "Enter the 6-digit code from WhatsApp." });

  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient || !SUPABASE_URL || !serviceRoleKey) {
    return json(500, { error: "Verification is not configured on the server." });
  }

  // Same no-op WebSocket shim as public-book-appointment.js (Node 20 on Netlify).
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }
  const supabase = createClient(SUPABASE_URL, serviceRoleKey);

  try {
    const { data: token, error } = await supabase.rpc("service_verify_phone_otp_token", { p_phone: canonical, p_code: digits });
    if (error) throw error;
    if (!token) return json(400, { error: "That code is incorrect or has expired. Check WhatsApp or request a new code." });
    return json(200, { success: true, token });
  } catch (error) {
    console.error("verify-booking-otp error:", error);
    return json(500, { error: "Could not verify the code. Please try again." });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

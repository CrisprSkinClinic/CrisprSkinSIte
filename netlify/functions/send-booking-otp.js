// netlify/functions/send-booking-otp.js
//
// Sends a 6-digit WhatsApp verification code to the phone number a patient
// enters in BookingCalendar.astro. public-book-appointment.js refuses to book
// until that code is verified, so an appointment can only be made for a
// WhatsApp number the person booking actually holds.
//
// Delegates to the AppointmentManager project's send-wa-otp-login Edge Function,
// which generates and stores the code (hashed, 5-minute expiry, max 3 requests
// per number per 15 minutes) and sends the approved "verify_code_1" template.
// Meta credentials stay in Supabase; this function only needs the project URL.

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const { canonicalIndianMobile } = require("./lib/booking-core.cjs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let phone;
  try {
    ({ phone } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { error: "Invalid request body" });
  }

  const canonical = canonicalIndianMobile(phone);
  if (!canonical) {
    return json(400, { error: "Enter a valid 10-digit Indian mobile number that uses WhatsApp." });
  }
  if (!SUPABASE_URL) {
    return json(500, { error: "APPOINTMENT_MANAGER_SUPABASE_URL environment variable is missing." });
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-wa-otp-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: canonical }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.success) {
      const message = result.error || "";
      if (/too many/i.test(message)) return json(429, { error: message });
      console.error("send-wa-otp-login failed:", res.status, message);
      return json(502, { error: "Could not send the WhatsApp code. Check the number is on WhatsApp, or call us to book." });
    }
    return json(200, { success: true });
  } catch (error) {
    console.error("send-booking-otp error:", error);
    return json(500, { error: "Could not send the WhatsApp code. Please try again." });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

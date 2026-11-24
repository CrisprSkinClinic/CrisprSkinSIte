// netlify/functions/public-partner-prefill.js
//
// After a rep verifies their WhatsApp number on /partner-register, return what the clinic already holds for that number
// (details, usual terms, distributors, price list) so the form opens filled in and the rep only corrects what changed.
// Gated by the verified one-time token (peeked, not used up -- the submit uses it up). Only the verified number's own record.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const fail = (statusCode, error, extra = {}) => ({ statusCode, body: JSON.stringify({ error, ...extra }) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  if (!createClient) return fail(500, "Server module @supabase/supabase-js failed to load.");
  const key = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) return fail(500, "Server is not configured correctly.");
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }
  let body;
  try { body = JSON.parse(event.body) || {}; } catch { return fail(400, "Invalid request body"); }
  const phone = String(body.phone || "").replace(/\D/g, "").slice(-10);
  if (!/^[6-9][0-9]{9}$/.test(phone)) return fail(400, "A valid 10-digit mobile number is required.");
  if (!UUID.test(String(body.otpToken || ""))) return fail(403, "Please verify your WhatsApp number.", { verificationExpired: true });

  const supabase = createClient(SUPABASE_URL, key);
  try {
    const peek = await supabase.rpc("service_peek_phone_otp_token", { p_phone: `91${phone}`, p_token: String(body.otpToken) });
    if (peek.error) throw peek.error;
    if (!peek.data) return fail(403, "Your WhatsApp verification has expired. Please verify your number again.", { verificationExpired: true });
    const { data, error } = await supabase.rpc("service_partner_prefill_v1", { p_phone: phone });
    if (error) throw error;
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(data || { existing: false }) };
  } catch (e) {
    console.error("public-partner-prefill error:", e);
    return fail(500, "Could not load your details.");
  }
};

// netlify/functions/public-partner-registration.js
//
// Public function behind /partner-register. Medical representatives and distributors register themselves; the
// request lands in partner_registrations (AppointmentManager Supabase project) and only becomes a Partner in the
// clinic app once staff approve it. Like public-patient-registration.js the endpoint is public, so trust comes from
// validation plus the WhatsApp-verified one-time token, which is used up here.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const fail = (statusCode, error, extra = {}) => ({ statusCode, body: JSON.stringify({ error, ...extra }) });
const clean = (v, max = 200) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  if (!createClient) return fail(500, "Server module @supabase/supabase-js failed to load.");
  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !serviceRoleKey) return fail(500, "Server is not configured correctly.");
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }

  let body;
  try { body = JSON.parse(event.body); } catch { return fail(400, "Invalid request body"); }
  body = body || {};
  // Bots fill the hidden field; answer as if it worked.
  if (clean(body.website)) return { statusCode: 200, body: JSON.stringify({ success: true }) };

  const kind = body.kind === "distributor" ? "distributor" : body.kind === "rep" ? "rep" : "";
  if (!kind) return fail(400, "Please choose whether you are a medical representative or a distributor.");
  const phone = clean(body.phone, 10);
  if (!/^[6-9][0-9]{9}$/.test(phone)) return fail(400, "A valid 10-digit mobile number is required.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.otpToken || ""))) {
    return fail(403, "Please verify your WhatsApp number.", { verificationExpired: true });
  }
  const email = clean(body.email, 120);
  if (email && !EMAIL.test(email)) return fail(400, "Please enter a valid email address.");

  let payload;
  if (kind === "rep") {
    const firstName = clean(body.firstName, 60);
    const company = clean(body.company, 120);
    if (!firstName) return fail(400, "Your first name is required.");
    if (!company) return fail(400, "Your company is required.");
    payload = {
      salutation: clean(body.salutation, 10), firstName, lastName: clean(body.lastName, 60), phone, email,
      designation: clean(body.designation, 80), company, division: clean(body.division, 120),
      distributors: clean(body.distributors, 300), deliveryDays: clean(body.deliveryDays, 3).replace(/\D/g, ""),
      moq: clean(body.moq, 6).replace(/\D/g, ""), paymentTerms: clean(body.paymentTerms, 120), offerFreeDetails: clean(body.offerFreeDetails, 300),
    };
  } else {
    const name = clean(body.name, 120);
    if (!name) return fail(400, "The distributor's name is required.");
    const gstin = clean(body.gstin, 15).toUpperCase();
    if (gstin && !GSTIN.test(gstin)) return fail(400, "That GSTIN does not look right. Please check it.");
    payload = {
      name, contactPerson: clean(body.contactPerson, 80), phone, email, gstin, dlNumber: clean(body.dlNumber, 60),
      pan: clean(body.pan, 10).toUpperCase(), address: clean(body.address, 300), city: clean(body.city, 80), state: clean(body.state, 80),
      companies: clean(body.companies, 400),
    };
  }
  for (const k of Object.keys(payload)) if (payload[k] === "") delete payload[k];

  const supabase = createClient(SUPABASE_URL, serviceRoleKey);
  try {
    const { data: tokenOk, error: tokenError } = await supabase.rpc("service_consume_phone_otp_token", { p_phone: `91${phone}`, p_token: String(body.otpToken) });
    if (tokenError) throw tokenError;
    if (!tokenOk) return fail(403, "Your WhatsApp verification has expired. Please verify your number again.", { verificationExpired: true });

    const { data: requestId, error } = await supabase.rpc("service_submit_partner_registration_v1", { p_kind: kind, p_payload: payload, p_source: "website" });
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ success: true, requestId }) };
  } catch (error) {
    console.error("public-partner-registration error:", error);
    return fail(500, "Something went wrong. Please try again or contact the clinic directly.");
  }
};

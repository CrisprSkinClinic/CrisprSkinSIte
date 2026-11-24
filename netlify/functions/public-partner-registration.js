// netlify/functions/public-partner-registration.js
//
// Public function behind /partner-register. Medical representatives register themselves; the
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

  const phone = clean(body.phone, 10);
  if (!/^[6-9][0-9]{9}$/.test(phone)) return fail(400, "A valid 10-digit mobile number is required.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.otpToken || ""))) {
    return fail(403, "Please verify your WhatsApp number.", { verificationExpired: true });
  }
  const email = clean(body.email, 120);
  if (email && !EMAIL.test(email)) return fail(400, "Please enter a valid email address.");
  const firstName = clean(body.firstName, 60);
  const company = clean(body.company, 120);
  if (!firstName) return fail(400, "Your name is required.");
  if (!company) return fail(400, "Your company is required.");

  const num = (v, max) => { const n = Number(String(v == null ? "" : v).replace(/,/g, "")); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
  const OFFER_TYPES = ["Scheme", "Discount", "No_Offer"];
  const offerType = OFFER_TYPES.includes(body.offerType) ? body.offerType : "";
  const buy = num(body.buyQty, 100000);
  const free = num(body.freeQty, 100000);
  const margin = num(body.marginPercent, 100);
  let offerFreeDetails = "";
  if (offerType === "Scheme" && buy && free) offerFreeDetails = `Buy ${buy} get ${free} free`;

  const priceList = (Array.isArray(body.priceList) ? body.priceList : []).slice(0, 400).map((r) => ({
    category: clean(r && r.category, 80), brand: clean(r && r.brand, 80), ingredients: clean(r && r.ingredients, 300),
    sku: clean(r && r.sku, 120), ptr: num(r && r.ptr, 10000000), mrp: num(r && r.mrp, 10000000), stockist: clean(r && r.stockist, 120),
  })).filter((r) => r.sku);
  const otherDivisions = (Array.isArray(body.otherDivisions) ? body.otherDivisions : []).slice(0, 30).map((d) => ({
    name: clean(d && d.name, 80), contactName: clean(d && d.contactName, 80), phone: clean(d && d.phone, 15).replace(/[^\d+ ]/g, ""),
  })).filter((d) => d.name);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uploadIds = (Array.isArray(body.uploadIds) ? body.uploadIds : []).filter((x) => UUID.test(String(x))).slice(0, 10);

  const payload = {
    salutation: clean(body.salutation, 10), firstName, lastName: clean(body.lastName, 60), phone, email,
    designation: clean(body.designation, 80), company, division: clean(body.division, 120),
    offerType: offerType === "No_Offer" ? "No offer" : offerType, offerFreeDetails,
    offerDiscountPercent: offerType === "Discount" ? margin : null, buyQty: offerType === "Scheme" ? buy : null, freeQty: offerType === "Scheme" ? free : null,
    moq: num(body.moq, 10000000), deliveryDays: num(body.deliveryDays, 365), paymentTerms: clean(body.paymentTerms, 120), cashDiscountPercent: num(body.cashDiscountPercent, 100),
    medvolApp: body.medvolApp === true || body.medvolApp === "Yes" ? "true" : body.medvolApp === false || body.medvolApp === "No" ? "false" : "",
    stockists: (Array.isArray(body.stockists) ? body.stockists : []).map((x) => clean(x, 120)).filter(Boolean).slice(0, 12),
    prefStockist: clean(body.prefStockist, 120), secStockist1: clean(body.secStockist1, 120), secStockist2: clean(body.secStockist2, 120),
    uploadIds,
    priceList, otherDivisions,
  };
  for (const k of Object.keys(payload)) if (payload[k] === "" || payload[k] === null) delete payload[k];
  if (!payload.stockists || !payload.stockists.length) delete payload.stockists;
  if (!priceList.length) delete payload.priceList;
  if (!otherDivisions.length) delete payload.otherDivisions;
  if (!uploadIds.length) delete payload.uploadIds;
  const kind = "rep";

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

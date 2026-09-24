// netlify/functions/public-returning-patient.js
//
// After a patient verifies their WhatsApp number (verify-booking-otp.js),
// BookingCalendar.astro calls this to greet a returning patient with their last
// consultation and pre-select that doctor. Requires the unused verification
// token for this phone, so visit history is only shown to the number's owner.
// The patient must match on name as well as phone: family members often share
// a number and must not see each other's visits.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

// Must match send-booking-otp.js / verify-booking-otp.js / public-book-appointment.js.
function canonicalIndianMobile(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : null;
}

// Same rule as public-book-appointment.js: ignore title, case and punctuation.
function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^(mr|mrs|ms|miss|dr|master|baby)\.?\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }

  const canonical = canonicalIndianMobile(payload.phone);
  const name = String(payload.name || "").trim();
  if (!canonical || !normalizeName(name) || !payload.otpToken) {
    return json(400, { error: "Name, verified phone and verification token are required." });
  }

  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient || !SUPABASE_URL || !serviceRoleKey) {
    return json(500, { error: "Patient lookup is temporarily unavailable." });
  }
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }
  const supabase = createClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const { data: tokenValid, error: tokenError } = await supabase.rpc("service_peek_phone_otp_token", {
      p_phone: canonical,
      p_token: String(payload.otpToken),
    });
    if (tokenError && !/uuid/i.test(tokenError.message || "")) throw tokenError;
    if (!tokenValid) return json(403, { error: "Please verify your WhatsApp number again." });

    const last = await lastConsultation(supabase, canonical, name);
    if (!last?.date) return json(200, { found: false });
    return json(200, { found: true, lastConsultation: { date: last.date, doctorId: last.doctorId, doctorName: last.doctorName } });
  } catch (error) {
    console.error("public-returning-patient error:", error.message);
    return json(500, { error: "Patient lookup is temporarily unavailable." });
  }
};

// Exported for public-book-appointment.js so the server, not the browser,
// decides whether a booking is a review.
async function lastConsultation(supabase, canonicalPhone, name) {
  const { data: patients, error } = await supabase.rpc("service_find_patients_by_phone", { p_phone: canonicalPhone });
  if (error) throw error;
  const patient = (patients || []).find((row) => normalizeName(row.name) === normalizeName(name));
  if (!patient) return null;

  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const { data: visit, error: visitError } = await supabase
    .from("appointments")
    .select("slot_date, doctor_id, doctors(name)")
    .eq("patient_id", patient.id)
    .lte("slot_date", today)
    .in("status", ["seen", "complete"])
    .is("deleted_at", null)
    .order("slot_date", { ascending: false })
    .order("slot_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (visitError) throw visitError;
  if (!visit) return { patientId: patient.id, date: null };
  return { patientId: patient.id, date: visit.slot_date, doctorId: visit.doctor_id, doctorName: visit.doctors?.name || null };
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

exports.lastConsultation = lastConsultation;
exports.normalizeName = normalizeName;

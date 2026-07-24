// netlify/functions/public-patient-registration.js
//
// Public-facing function used by the /register page. Lets a patient
// self-register directly into the AppointmentManager Supabase project's
// patient_registration_requests table -- NOT the real patients table.
// Every submission requires staff approval via Bookings Manager before
// it becomes a real patient record, which prevents unverified,
// duplicate, or spam entries from landing directly in the live patient
// list. There is no password gate here -- like public-book-appointment.js,
// this endpoint is intentionally public, so validation logic (not auth)
// is what enforces trust boundaries.
//
// Field set matches Step 1 ("Personal Information") of the intake
// wizard prototype: salutation/first/last name, DOB (DD/MM/YYYY from
// the client, converted to ISO here), gender, email, phone, address
// (now split into pincode/area/city/state -- auto-filled from the
// pincode via India Post's API on the client -- plus a door/street
// free-text field), occupation, referral source(+other). All
// required, same as the wizard. This does NOT include wizard Steps
// 2-5 (health background, symptom picker, diagnosis questions,
// consent) -- those belong to the separate, not-yet-built
// patient_intake_forms feature.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

function ok(body, statusCode = 200) {
  return { statusCode, body: JSON.stringify(body) };
}

// Converts a DD/MM/YYYY string to an ISO YYYY-MM-DD date, or null if
// the input isn't a valid DD/MM/YYYY date. Mirrors the wizard's own
// parseDOB logic so both surfaces agree on what counts as valid.
function parseDOBToISO(str) {
  const match = String(str || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, ddStr, mmStr, yyyyStr] = match;
  const dd = Number(ddStr);
  const mm = Number(mmStr);
  const yyyy = Number(yyyyStr);
  const d = new Date(yyyy, mm - 1, dd);
  if (Number.isNaN(d.getTime()) || d > new Date()) return null;
  // Guard against JS Date's auto-rollover (e.g. 31/02/2024 silently
  // becoming March) by checking the parts round-trip exactly.
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return `${yyyyStr}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!createClient) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server module @supabase/supabase-js failed to load." }) };
  }
  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !serviceRoleKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server is not configured correctly." }) };
  }

  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      constructor() {}
      close() {}
      send() {}
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const {
    salutation,
    firstName,
    lastName,
    name,
    dob,
    gender,
    email,
    phone,
    pincode,
    area,
    city,
    state,
    address,
    occupation,
    referralSource,
    referralOtherDetails,
  } = payload || {};

  const VALID_SALUTATIONS = ["Mr.", "Ms.", "Mrs.", "Dr.", "Master", "Baby"];
  const VALID_REFERRAL_SOURCES = [
    "Friend/Family Referral",
    "Doctor Referral",
    "Google Search",
    "Social Media",
    "Practo",
    "Walk-in",
    "Other",
  ];

  if (!salutation || !VALID_SALUTATIONS.includes(salutation)) {
    return { statusCode: 400, body: JSON.stringify({ error: "A valid salutation is required." }) };
  }
  if (!firstName || !String(firstName).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "First name is required." }) };
  }
  if (!lastName || !String(lastName).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Last name is required." }) };
  }
  const isoDob = parseDOBToISO(dob);
  if (!isoDob) {
    return { statusCode: 400, body: JSON.stringify({ error: "A valid date of birth (DD/MM/YYYY) is required." }) };
  }
  if (!gender || !["male", "female", "other"].includes(gender)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Gender must be male, female, or other." }) };
  }
  if (!email || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(com|in)$/.test(String(email).trim())) {
    return { statusCode: 400, body: JSON.stringify({ error: "A valid email address is required." }) };
  }
  if (!phone || !/^[6-9][0-9]{9}$/.test(String(phone).trim())) {
    return { statusCode: 400, body: JSON.stringify({ error: "A valid 10-digit phone number is required." }) };
  }
  if (!pincode || !/^[0-9]{6}$/.test(String(pincode).trim())) {
    return { statusCode: 400, body: JSON.stringify({ error: "A valid 6-digit pincode is required." }) };
  }
  if (!area || !String(area).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Area is required." }) };
  }
  if (!city || !String(city).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "City is required." }) };
  }
  if (!state || !String(state).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "State is required." }) };
  }
  if (!address || String(address).trim().length < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please enter your door no. / apartment / street." }) };
  }
  if (!occupation || !String(occupation).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Occupation is required." }) };
  }
  if (!referralSource || !VALID_REFERRAL_SOURCES.includes(referralSource)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please let us know how you heard about us." }) };
  }
  if (referralSource === "Other" && !String(referralOtherDetails || "").trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please specify how you heard about us." }) };
  }

  const fullName = name && String(name).trim()
    ? String(name).trim()
    : `${salutation} ${firstName} ${lastName}`.trim();

  const supabase = createClient(SUPABASE_URL, serviceRoleKey);

  try {
    // patient_registration_requests stores all PII in encrypted
    // columns (name_enc, phone_enc, etc.) -- a direct .insert() with
    // plaintext field names would fail since those columns no longer
    // exist. insert_registration_request_encrypted (SECURITY DEFINER,
    // service_role only) takes plaintext arguments and handles
    // encryption + the phone_hash computation server-side.
    const { data: requestId, error } = await supabase.rpc("insert_registration_request_encrypted", {
      p_name: fullName,
      p_salutation: salutation,
      p_first_name: String(firstName).trim(),
      p_last_name: String(lastName).trim(),
      p_phone: String(phone).trim(),
      p_dob: isoDob,
      p_gender: gender,
      p_email: String(email).trim(),
      p_pincode: String(pincode).trim(),
      p_area: String(area).trim(),
      p_city: String(city).trim(),
      p_state: String(state).trim(),
      p_address: String(address).trim(),
      p_occupation: String(occupation).trim(),
      p_referral_source: referralSource,
      p_referral_other_details: referralSource === "Other" ? String(referralOtherDetails).trim() : null,
    });
    if (error) throw error;

    return ok({ success: true, requestId });
  } catch (error) {
    console.error("public-patient-registration error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Something went wrong. Please try again or contact the clinic directly." }),
    };
  }
};

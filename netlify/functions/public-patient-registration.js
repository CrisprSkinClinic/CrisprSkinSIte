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

  const { name, phone, dob, gender, address } = payload || {};

  if (!name || !String(name).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Name is required." }) };
  }
  if (gender && !["male", "female", "other"].includes(gender)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Gender must be male, female, or other." }) };
  }
  // dob is optional, but if given must be a real, non-future date --
  // a simple guard against obvious typos (e.g. a future year) without
  // being unnecessarily strict about exact format edge cases.
  if (dob) {
    const dobDate = new Date(dob);
    if (Number.isNaN(dobDate.getTime()) || dobDate > new Date()) {
      return { statusCode: 400, body: JSON.stringify({ error: "Please enter a valid date of birth." }) };
    }
  }

  const supabase = createClient(SUPABASE_URL, serviceRoleKey);

  try {
    const { data: request, error } = await supabase
      .from("patient_registration_requests")
      .insert({
        name: String(name).trim(),
        phone: phone ? String(phone).trim() : null,
        dob: dob || null,
        gender: gender || null,
        address: address ? String(address).trim() : null,
      })
      .select("id")
      .single();
    if (error) throw error;

    return ok({ success: true, requestId: request.id });
  } catch (error) {
    console.error("public-patient-registration error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Something went wrong. Please try again or contact the clinic directly." }),
    };
  }
};

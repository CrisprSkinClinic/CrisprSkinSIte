// Looks up a returning patient only after both name and phone match.
// The service-role key remains server-side, and the response contains only
// the minimum appointment information needed by the public booking form.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method Not Allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Invalid request body" });
  }

  const name = String(payload.name || "").trim();
  const phone = normalizePhone(payload.phone);
  if (name.length < 2 || phone.length !== 10) {
    return response(400, { error: "Enter a valid name and 10-digit mobile number." });
  }

  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient || !SUPABASE_URL || !serviceRoleKey) {
    return response(500, { error: "Patient lookup is temporarily unavailable." });
  }

  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      close() {}
      send() {}
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: patients, error: patientError } = await supabase.rpc(
      "find_patient_by_phone",
      { p_phone: phone }
    );
    if (patientError) throw patientError;

    const patient = (patients || []).find(
      (row) => normalizeName(row.name) === normalizeName(name)
    );
    if (!patient) return response(200, { found: false });

    const today = new Date().toISOString().slice(0, 10);
    const { data: lastAppointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("slot_date, doctor_id")
      .eq("patient_id", patient.id)
      .lte("slot_date", today)
      .neq("status", "cancelled")
      .is("deleted_at", null)
      .order("slot_date", { ascending: false })
      .order("slot_time", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (appointmentError) throw appointmentError;
    if (!lastAppointment) return response(200, { found: false });

    const { data: doctor, error: doctorError } = await supabase
      .from("doctors")
      .select("name")
      .eq("id", lastAppointment.doctor_id)
      .maybeSingle();
    if (doctorError) throw doctorError;

    return response(200, {
      found: true,
      appointmentType: "review",
      lastAppointment: {
        date: lastAppointment.slot_date,
        doctorId: lastAppointment.doctor_id,
        doctorName: doctor?.name || "your previous doctor",
      },
    });
  } catch (error) {
    console.error("public-returning-patient error:", error.message);
    return response(500, { error: "Patient lookup is temporarily unavailable." });
  }
};

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^(mr|mrs|ms|miss|dr)\.?\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

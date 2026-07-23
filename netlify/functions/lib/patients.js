// netlify/functions/lib/patients.js
//
// Patient lookup, history, profile read/update -- all patient PII
// (name/phone/dob/address) lives in encrypted columns (name_enc etc.)
// on the patients table, so every read/write here goes through the
// RPC helpers (find_patient_by_phone, get_patient_profile_decrypted,
// update_patient_encrypted) rather than querying patients directly.
// Those RPCs are SECURITY DEFINER and locked to service_role, so this
// module -- running with the service-role client -- is the only
// intended caller.

const { ok } = require("./supabase-client");

async function lookupPatientByPhone(supabase, data) {
  if (!data?.phone) {
    return { statusCode: 400, body: JSON.stringify({ error: "phone is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("find_patient_by_phone", { p_phone: data.phone });
  if (error) throw error;
  if (!rows || rows.length === 0) {
    return ok({ found: false });
  }
  const patient = rows[0];

  // Also surface the doctor from their most recent non-cancelled
  // appointment, so the booking form can suggest "last seen by" for a
  // Review visit without a second round trip -- unchanged from before,
  // appointments.doctor_id/slot_date/doctors(name) are not encrypted.
  const { data: lastAppt } = await supabase
    .from("appointments")
    .select("doctor_id, slot_date, doctors(name)")
    .eq("patient_id", patient.id)
    .not("status", "in", "(cancelled)")
    .order("slot_date", { ascending: false })
    .limit(1);

  return ok({
    found: true,
    patient: { id: patient.id, name: patient.name, phone: patient.phone },
    lastDoctorId: lastAppt?.[0]?.doctor_id || null,
    lastDoctorName: lastAppt?.[0]?.doctors?.name || null,
    lastVisitDate: lastAppt?.[0]?.slot_date || null,
  });
}

async function getPatientHistory(supabase, data) {
  if (!data?.patient_id) {
    return { statusCode: 400, body: JSON.stringify({ error: "patient_id is required." }) };
  }
  // Appointment rows themselves carry no patient PII (patient_id is a
  // reference, not a name/phone), so this query is unaffected by the
  // encryption change.
  const { data: visits, error } = await supabase
    .from("appointments")
    .select("*, doctors(name)")
    .eq("patient_id", data.patient_id)
    .order("slot_date", { ascending: false })
    .order("slot_time", { ascending: false });
  if (error) throw error;
  return ok({ visits });
}

async function getPatientProfile(supabase, data) {
  if (!data?.patient_id) {
    return { statusCode: 400, body: JSON.stringify({ error: "patient_id is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("get_patient_profile_decrypted", { p_patient_id: data.patient_id });
  if (error) throw error;
  if (!rows || rows.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: "Patient not found." }) };
  }
  return ok({ patient: rows[0] });
}

async function updatePatientProfile(supabase, data, logAudit) {
  if (!data?.patient_id) {
    return { statusCode: 400, body: JSON.stringify({ error: "patient_id is required." }) };
  }
  // gender is constrained at the database level to male/female/other
  // (patients_gender_check) -- validated here too so a bad value
  // produces a readable error instead of a raw Postgres constraint
  // violation message.
  if (data.gender && !["male", "female", "other"].includes(data.gender)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Gender must be male, female, or other." }) };
  }

  const { error } = await supabase.rpc("update_patient_encrypted", {
    p_patient_id: data.patient_id,
    p_update_name: data.name !== undefined,
    p_name: data.name ?? null,
    p_update_phone: data.phone !== undefined,
    p_phone: data.phone || null,
    p_update_dob: data.dob !== undefined,
    p_dob: data.dob || null,
    p_update_gender: data.gender !== undefined,
    p_gender: data.gender || null,
    p_update_address: data.address !== undefined,
    p_address: data.address || null,
    p_update_is_registered: false,
    p_is_registered: false,
    p_update_pincode: data.pincode !== undefined,
    p_pincode: data.pincode || null,
    p_update_area: data.area !== undefined,
    p_area: data.area || null,
    p_update_city: data.city !== undefined,
    p_city: data.city || null,
    p_update_state: data.state !== undefined,
    p_state: data.state || null,
    p_update_email: data.email !== undefined,
    p_email: data.email || null,
    p_update_occupation: data.occupation !== undefined,
    p_occupation: data.occupation || null,
    p_update_referral_source: data.referralSource !== undefined,
    p_referral_source: data.referralSource || null,
    p_update_referral_other_details: data.referralOtherDetails !== undefined,
    p_referral_other_details: data.referralOtherDetails || null,
  });
  if (error) throw error;

  await logAudit("UPDATE", `Updated patient profile for patient ${data.patient_id}`);
  return ok({ success: true });
}

module.exports = { lookupPatientByPhone, getPatientHistory, getPatientProfile, updatePatientProfile };

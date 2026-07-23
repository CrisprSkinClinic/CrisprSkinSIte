// netlify/functions/lib/registrations.js
//
// Patient self-registration approval flow. patient_registration_requests
// now stores all PII (name/phone/dob/email/address/area/city/state/
// occupation/referral-other) in encrypted columns, so listing and
// reading requests goes through list_registration_requests_decrypted /
// get_registration_request_decrypted, and the approve flow's duplicate
// check uses find_patient_by_phone (hash-based lookup) instead of a
// direct .eq("phone", ...) filter, since encrypted values can't be
// searched directly.

const { ok } = require("./supabase-client");

async function listRegistrationRequests(supabase, data) {
  const statusFilter = data?.status || "pending";
  const { data: requests, error } = await supabase.rpc("list_registration_requests_decrypted", { p_status: statusFilter });
  if (error) throw error;
  return ok({ requests });
}

async function approveRegistrationRequest(supabase, data, profile, logAudit) {
  if (!data?.requestId) {
    return { statusCode: 400, body: JSON.stringify({ error: "requestId is required." }) };
  }
  const { data: rows, error: fetchErr } = await supabase.rpc("get_registration_request_decrypted", { p_request_id: data.requestId });
  if (fetchErr) throw fetchErr;
  if (!rows || rows.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: "Registration request not found." }) };
  }
  const request = rows[0];
  if (request.status !== "pending") {
    return { statusCode: 400, body: JSON.stringify({ error: "This request has already been reviewed." }) };
  }

  // Check for an existing patient with the same phone before creating
  // a new row -- a self-registration might be for someone who already
  // has a patient record (e.g. booked online previously), and
  // approving shouldn't silently create a duplicate. Uses the same
  // hash-based lookup as the public booking flow, since phone_enc
  // can't be searched with a direct equality filter.
  let patientId = null;
  if (request.phone) {
    const { data: existingRows } = await supabase.rpc("find_patient_by_phone", { p_phone: request.phone });
    if (existingRows && existingRows.length > 0) patientId = existingRows[0].id;
  }

  if (patientId) {
    const { error: updateErr } = await supabase.rpc("update_patient_encrypted", {
      p_patient_id: patientId,
      p_update_name: true,
      p_name: request.name,
      p_update_phone: false,
      p_phone: null,
      p_update_dob: true,
      p_dob: request.dob,
      p_update_gender: true,
      p_gender: request.gender,
      p_update_address: true,
      p_address: request.address,
      p_update_is_registered: true,
      p_is_registered: true,
    });
    if (updateErr) throw updateErr;
  } else {
    const { data: newPatientId, error: insertErr } = await supabase.rpc("insert_patient_encrypted", {
      p_name: request.name,
      p_phone: request.phone,
      p_dob: request.dob,
      p_gender: request.gender,
      p_address: request.address,
      p_is_registered: true,
    });
    if (insertErr) throw insertErr;
    patientId = newPatientId;
  }

  const { error: reqUpdateErr } = await supabase
    .from("patient_registration_requests")
    .update({
      status: "approved",
      approved_patient_id: patientId,
      reviewed_by: profile.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", data.requestId);
  if (reqUpdateErr) throw reqUpdateErr;

  await logAudit("APPROVE", `Approved registration for ${request.name}`);
  return ok({ success: true, patientId });
}

async function rejectRegistrationRequest(supabase, data, profile, logAudit) {
  if (!data?.requestId) {
    return { statusCode: 400, body: JSON.stringify({ error: "requestId is required." }) };
  }
  // Only status/name needed here, both are cheap via the decrypted RPC
  // (name requires decryption; status does not, but the RPC returns
  // both together rather than needing a second raw query).
  const { data: rows, error: fetchErr } = await supabase.rpc("get_registration_request_decrypted", { p_request_id: data.requestId });
  if (fetchErr) throw fetchErr;
  if (!rows || rows.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: "Registration request not found." }) };
  }
  const request = rows[0];
  if (request.status !== "pending") {
    return { statusCode: 400, body: JSON.stringify({ error: "This request has already been reviewed." }) };
  }

  const { error } = await supabase
    .from("patient_registration_requests")
    .update({
      status: "rejected",
      reviewed_by: profile.id,
      reviewed_at: new Date().toISOString(),
      rejection_reason: data.reason || null,
    })
    .eq("id", data.requestId);
  if (error) throw error;

  await logAudit("REJECT", `Rejected registration for ${request.name}${data.reason ? `: ${data.reason}` : ""}`);
  return ok({ success: true });
}

module.exports = { listRegistrationRequests, approveRegistrationRequest, rejectRegistrationRequest };

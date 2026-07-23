// netlify/functions/lib/rx-media.js
//
// Lab report and clinical photo METADATA actions. The actual files
// live on Google Drive (explicit decision, not Supabase Storage) --
// upload itself happens via a separate function (drive-upload.js,
// which talks to the Drive API directly), and this module only
// records/reads the resulting Drive file reference plus the
// lab-order/photo metadata around it.

const { ok } = require("./supabase-client");

async function getPatientLabHistory(supabase, data) {
  if (!data?.patientId) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("get_patient_lab_history", {
    p_patient_id: data.patientId,
    p_limit: data.limit || 5,
  });
  if (error) throw error;
  return ok({ reports: rows });
}

async function getPatientPhotos(supabase, data) {
  if (!data?.patientId) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("get_patient_photos", { p_patient_id: data.patientId });
  if (error) throw error;
  return ok({ photos: rows });
}

// Called AFTER drive-upload.js has already put the file on Drive and
// returned a file id/url -- this just records that reference plus the
// test name/date. Kept as a separate step (rather than one combined
// action) so the upload function stays focused purely on talking to
// Drive, and this one stays focused purely on Postgres.
async function recordLabOrder(supabase, data, profile) {
  if (!data?.patientId || !data?.testName || !data?.driveFileUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId, testName, and driveFileUrl are required." }) };
  }
  const { data: newId, error } = await supabase.rpc("insert_derm_rx_lab_order", {
    p_patient_id: data.patientId,
    p_prescription_id: data.prescriptionId || null,
    p_test_name: data.testName,
    p_drive_file_id: data.driveFileId || null,
    p_drive_file_url: data.driveFileUrl,
    p_uploaded_by: profile.id,
  });
  if (error) throw error;
  return ok({ success: true, labOrderId: newId });
}

async function updateLabNote(supabase, data) {
  if (!data?.labOrderId) {
    return { statusCode: 400, body: JSON.stringify({ error: "labOrderId is required." }) };
  }
  const { error } = await supabase.rpc("update_derm_rx_lab_note", { p_lab_order_id: data.labOrderId, p_note: data.note || null });
  if (error) throw error;
  return ok({ success: true });
}

async function recordPhoto(supabase, data, profile) {
  if (!data?.patientId || !data?.driveFileUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId and driveFileUrl are required." }) };
  }
  const { data: newId, error } = await supabase.rpc("insert_derm_rx_photo", {
    p_patient_id: data.patientId,
    p_prescription_id: data.prescriptionId || null,
    p_drive_file_id: data.driveFileId || null,
    p_drive_file_url: data.driveFileUrl,
    p_uploaded_by: profile.id,
  });
  if (error) throw error;
  return ok({ success: true, photoId: newId });
}

module.exports = { getPatientLabHistory, getPatientPhotos, recordLabOrder, updateLabNote, recordPhoto };

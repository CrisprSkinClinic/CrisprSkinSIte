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
// returned a file id -- this just records that reference plus the
// test name/date. driveFileId is the canonical, stable reference;
// no URL is stored at all, since files are private (see
// drive-file-proxy.js) and a URL that embeds a session's access
// token would go stale the moment that token expires. The frontend
// regenerates a fresh proxy URL from the stored file id every time
// it displays a file, rather than storing a URL upfront.
async function recordLabOrder(supabase, data, profile) {
  if (!data?.patientId || !data?.testName || !data?.driveFileId) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId, testName, and driveFileId are required." }) };
  }
  const { data: newId, error } = await supabase.rpc("insert_derm_rx_lab_order", {
    p_patient_id: data.patientId,
    p_prescription_id: data.prescriptionId || null,
    p_test_name: data.testName,
    p_drive_file_id: data.driveFileId,
    p_drive_file_url: null,
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
  if (!data?.patientId || !data?.driveFileId) {
    return { statusCode: 400, body: JSON.stringify({ error: "patientId and driveFileId are required." }) };
  }
  const { data: newId, error } = await supabase.rpc("insert_derm_rx_photo", {
    p_patient_id: data.patientId,
    p_prescription_id: data.prescriptionId || null,
    p_drive_file_id: data.driveFileId,
    p_drive_file_url: null,
    p_uploaded_by: profile.id,
  });
  if (error) throw error;
  return ok({ success: true, photoId: newId });
}

module.exports = { getPatientLabHistory, getPatientPhotos, recordLabOrder, updateLabNote, recordPhoto };

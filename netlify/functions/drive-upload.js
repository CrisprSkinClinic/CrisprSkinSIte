// netlify/functions/drive-upload.js
//
// Uploads a file (lab report or clinical photo) to Google Drive, then
// returns the resulting file id. Called by prescription-app.js's
// triggerPhotoUpload()/handleLabUpload() once the doctor picks a
// file -- after this succeeds, the frontend follows up with
// record_lab_order/record_photo (in prescription-manager.js) to save
// the Drive file id + metadata into Postgres.
//
// Uses OAuth as a real Google account (via lib/drive-oauth.js's
// stored refresh token) rather than a service account -- service
// accounts have no storage quota of their own (confirmed by Google's
// own error message on first attempt: "Service Accounts do not have
// storage quota"), and the two officially-suggested fixes (Shared
// Drives, domain-wide delegation) both require Google Workspace,
// which isn't available here (personal Google account only).
// Uploads under this approach count against the connected personal
// account's own 15GB Drive quota instead.
//
// Files are NOT made public here -- no "anyone with the link"
// permission is granted, same principle as before: viewing goes
// through drive-file-proxy.js, which re-checks staff auth on every
// request and streams the file via this same OAuth connection,
// rather than ever exposing a Drive URL directly to the browser.

const { getDriveAccessToken } = require("./lib/drive-oauth");

const LAB_REPORTS_FOLDER_ID = process.env.GOOGLE_DRIVE_LAB_REPORTS_FOLDER_ID;
const PHOTOS_FOLDER_ID = process.env.GOOGLE_DRIVE_PHOTOS_FOLDER_ID;

// Uploads a base64-encoded file to Drive via a multipart request
// (metadata + file content in one call). No sharing/permissions step
// -- the file is only ever accessible via this same OAuth connection,
// which is exactly what drive-file-proxy.js uses to serve it back out
// through an auth-gated endpoint.
async function uploadToDrive(accessToken, folderId, fileName, mimeType, base64Data) {
  const boundary = "rx_upload_boundary_" + Date.now();
  const metadata = { name: fileName, parents: [folderId] };
  const fileBuffer = Buffer.from(base64Data, "base64");

  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const uploadResponse = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });
  const uploadData = await uploadResponse.json();
  if (!uploadResponse.ok) {
    throw new Error(uploadData.error?.message || "Drive upload failed.");
  }
  return uploadData.id;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!LAB_REPORTS_FOLDER_ID || !PHOTOS_FOLDER_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "Google Drive folder IDs are not configured." }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { uploadType, fileName, mimeType, fileData } = payload || {};

  if (!uploadType || !["lab_report", "photo"].includes(uploadType)) {
    return { statusCode: 400, body: JSON.stringify({ error: "uploadType must be 'lab_report' or 'photo'." }) };
  }
  if (!fileName || !mimeType || !fileData) {
    return { statusCode: 400, body: JSON.stringify({ error: "fileName, mimeType, and fileData (base64) are required." }) };
  }
  const approxBytes = fileData.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return { statusCode: 400, body: JSON.stringify({ error: "File too large (max 5MB)." }) };
  }

  const folderId = uploadType === "lab_report" ? LAB_REPORTS_FOLDER_ID : PHOTOS_FOLDER_ID;

  try {
    const accessToken = await getDriveAccessToken();
    const fileId = await uploadToDrive(accessToken, folderId, fileName, mimeType, fileData);
    return { statusCode: 200, body: JSON.stringify({ success: true, driveFileId: fileId }) };
  } catch (error) {
    console.error("drive-upload error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Upload failed." }) };
  }
};

// netlify/functions/drive-upload.js
//
// Uploads a file (lab report or clinical photo) to Google Drive using
// a service account, then returns the resulting file id. Called by
// prescription-app.js's triggerPhotoUpload()/handleLabUpload() once
// the doctor picks a file -- after this succeeds, the frontend
// follows up with record_lab_order/record_photo (in
// prescription-manager.js) to save the Drive file id + metadata into
// Postgres.
//
// Uses direct JWT signing + the Drive REST API via fetch() rather
// than the googleapis npm package -- the actual surface area needed
// (service-account auth token + one multipart upload call, or one
// download call in drive-file-proxy.js) is small, and this avoids
// adding a heavy dependency, consistent with the rest of this
// codebase's functions.
//
// Files are NOT made public here -- no "anyone with the link"
// permission is granted. They stay visible only to the service
// account itself. Viewing goes through drive-file-proxy.js, which
// re-checks staff auth on every request and streams the file via the
// service account's own access, rather than ever exposing a Drive URL
// directly to the browser. This is stricter than a public-link
// approach but means access can be revoked instantly (deactivate the
// staff account) and is auditable, rather than being a permanent,
// unrevocable link once it exists.

const CLIENT_EMAIL = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_DRIVE_PRIVATE_KEY ? process.env.GOOGLE_DRIVE_PRIVATE_KEY.replace(/\\n/g, "\n") : null;
const LAB_REPORTS_FOLDER_ID = process.env.GOOGLE_DRIVE_LAB_REPORTS_FOLDER_ID;
const PHOTOS_FOLDER_ID = process.env.GOOGLE_DRIVE_PHOTOS_FOLDER_ID;

const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Signs a Google service-account JWT and exchanges it for an OAuth
// access token -- the standard "server-to-server" auth flow Google
// documents for service accounts, done by hand here instead of via
// the googleapis/google-auth-library packages (see file header).
// Not cached across invocations -- Netlify functions are short-lived/
// stateless, so each invocation gets its own token.
async function getDriveAccessToken(scope) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: CLIENT_EMAIL,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(PRIVATE_KEY);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Failed to authenticate with Google Drive.");
  }
  return data.access_token;
}

// Uploads a base64-encoded file to Drive via a multipart request
// (metadata + file content in one call). No sharing/permissions step
// -- the file is only ever accessible via the service account's own
// credentials, which is exactly what drive-file-proxy.js uses to
// serve it back out through an auth-gated endpoint.
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

  if (!CLIENT_EMAIL || !PRIVATE_KEY || !LAB_REPORTS_FOLDER_ID || !PHOTOS_FOLDER_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "Google Drive is not configured (missing environment variables)." }) };
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
  // 5MB limit, matching the old Apps Script tool's own cap -- base64
  // is ~33% larger than the raw bytes, so check against the decoded
  // size rather than the base64 string length.
  const approxBytes = fileData.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return { statusCode: 400, body: JSON.stringify({ error: "File too large (max 5MB)." }) };
  }

  const folderId = uploadType === "lab_report" ? LAB_REPORTS_FOLDER_ID : PHOTOS_FOLDER_ID;

  try {
    const accessToken = await getDriveAccessToken("https://www.googleapis.com/auth/drive.file");
    const fileId = await uploadToDrive(accessToken, folderId, fileName, mimeType, fileData);
    // No public URL returned -- the frontend stores/uses driveFileId
    // and fetches the actual content later via drive-file-proxy.js,
    // e.g. /.netlify/functions/drive-file-proxy?fileId=...&accessToken=...
    return { statusCode: 200, body: JSON.stringify({ success: true, driveFileId: fileId }) };
  } catch (error) {
    console.error("drive-upload error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Upload failed." }) };
  }
};

module.exports.getDriveAccessToken = getDriveAccessToken;

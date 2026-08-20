// netlify/functions/lib/drive-upload-helper.js
//
// Extracted from drive-upload.js's uploadToDrive() so it can be
// reused by pharmacy-ai.js (invoice/payment-screenshot archival)
// without duplicating the multipart-upload logic. drive-upload.js
// itself is left as the entry point for /prescription's lab-report/
// photo uploads and should be updated to require this file instead
// of keeping its own copy, next time that file is touched.

// Uploads a base64-encoded file to Drive via a multipart request
// (metadata + file content in one call). No sharing/permissions step
// -- callers that need the file viewable should go through their own
// auth-gated proxy, same principle as drive-file-proxy.js.
async function uploadToDrive(accessToken, folderId, fileName, mimeType, base64Data) {
  const boundary = "upload_boundary_" + Date.now();
  const metadata = { name: fileName, parents: [folderId] };
  const fileBuffer = Buffer.from(base64Data, "base64");

  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const uploadResponse = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
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
  return { fileId: uploadData.id, webViewLink: uploadData.webViewLink };
}

module.exports = { uploadToDrive };

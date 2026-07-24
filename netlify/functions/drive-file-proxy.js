// netlify/functions/drive-file-proxy.js
//
// Streams a Drive-hosted lab report or clinical photo back to the
// browser after re-verifying the requester is a signed-in doctor --
// this is what makes files private in practice: the Drive file itself
// grants NO public/link-based access (see drive-upload.js), so the
// only way to ever see its bytes is through this endpoint, which
// checks a real Supabase Auth session on every single request. Revoke
// a doctor's account and their access to every past upload is gone
// immediately, unlike a permanent "anyone with the link" URL.
//
// Uses OAuth as a real Google account (lib/drive-oauth.js) rather
// than a service account -- see drive-upload.js's header comment for
// why (service accounts have no Drive storage quota, and the
// Workspace-only fixes aren't available here).
//
// Frontend usage: an <img> or <iframe> src can't send a POST body or
// custom Authorization header, so the access token (the app's own
// Supabase session token, NOT the Google one) is passed as a query
// parameter instead. This is the standard, accepted workaround for
// authenticating direct browser navigations/media loads (same
// tradeoff Supabase's own signed URLs make) -- it's still short-lived
// (a Supabase access token expires on its own) and still requires an
// active, valid session, unlike a Drive "anyone with the link" grant
// which never expires and needs no ongoing authentication at all.

const { createServiceRoleClient } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");
const { getDriveAccessToken } = require("./lib/drive-oauth");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { fileId, accessToken } = event.queryStringParameters || {};
  if (!fileId || !accessToken) {
    return { statusCode: 400, body: JSON.stringify({ error: "fileId and accessToken query parameters are required." }) };
  }

  const { supabase, errorResponse: clientError } = createServiceRoleClient();
  if (clientError) return clientError;

  const { profile, errorResponse: authError } = await verifyStaffAuth(supabase, accessToken);
  if (authError) return authError;
  if (profile.role !== "doctor") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only doctor accounts can view clinical files." }) };
  }

  try {
    const driveToken = await getDriveAccessToken();

    const metaResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType,name`, {
      headers: { Authorization: `Bearer ${driveToken}` },
    });
    if (!metaResponse.ok) {
      return { statusCode: 404, body: JSON.stringify({ error: "File not found." }) };
    }
    const meta = await metaResponse.json();

    const fileResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${driveToken}` },
    });
    if (!fileResponse.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Failed to retrieve file from Drive." }) };
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    const base64Body = Buffer.from(arrayBuffer).toString("base64");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${meta.name || "file"}"`,
        "Cache-Control": "private, max-age=60",
      },
      body: base64Body,
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error("drive-file-proxy error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Failed to load file." }) };
  }
};

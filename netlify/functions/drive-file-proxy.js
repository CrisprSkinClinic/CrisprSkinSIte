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
// Frontend usage: an <img> or <iframe> src can't send a POST body or
// custom Authorization header, so the access token is passed as a
// query parameter instead. This is the standard, accepted workaround
// for authenticating direct browser navigations/media loads (same
// tradeoff Supabase's own signed URLs make) -- it's still short-lived
// (a Supabase access token expires on its own) and still requires an
// active, valid session, unlike a Drive "anyone with the link" grant
// which never expires and needs no ongoing authentication at all.

const { createServiceRoleClient } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");

const CLIENT_EMAIL = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_DRIVE_PRIVATE_KEY ? process.env.GOOGLE_DRIVE_PRIVATE_KEY.replace(/\\n/g, "\n") : null;

const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getDriveAccessToken() {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.file",
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
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Drive authentication failed.");
  return data.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Google Drive is not configured." }) };
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
        // Short cache on the CDN edge only (not the browser) -- keeps
        // repeated views of the same lab report snappy within a
        // session without weakening the auth check meaningfully,
        // since a fresh accessToken is still required to even reach
        // this far after the token expires.
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

// netlify/functions/drive-oauth-callback.js
//
// Handles Google's redirect after the one-time consent grant
// (triggered by /connect-drive.html). Exchanges the short-lived
// authorization code Google hands back for a REFRESH token -- the
// long-lived credential the app actually needs going forward.
//
// This function is only ever used ONCE (or again if the refresh
// token needs regenerating -- see drive-oauth.js's header comment on
// when that can happen). It does not get called during normal
// day-to-day photo/lab uploads; drive-upload.js and
// drive-file-proxy.js use lib/drive-oauth.js directly instead, which
// only needs the refresh token itself, not this exchange step.
//
// IMPORTANT: the refresh token this prints is a real credential --
// treat it exactly like a password. Copy it into the
// GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN Netlify env var immediately, then
// don't leave it sitting in a browser tab/screenshot/chat log longer
// than necessary.

const CLIENT_ID = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return { statusCode: 500, body: "Google Drive OAuth is not configured (missing client id/secret/redirect URI env vars)." };
  }

  const { code, error: oauthError } = event.queryStringParameters || {};
  if (oauthError) {
    return { statusCode: 400, body: `Google denied the consent request: ${oauthError}` };
  }
  if (!code) {
    return { statusCode: 400, body: "Missing authorization code from Google's redirect." };
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error_description || data.error || "Token exchange failed.");
    }

    if (!data.refresh_token) {
      // Google only returns a refresh_token on the FIRST consent grant
      // for a given app+account combination, unless the request
      // explicitly asks for a fresh one (prompt=consent, set in
      // connect-drive.html) -- if this happens, the fix is revoking
      // the app's access at https://myaccount.google.com/permissions
      // and redoing the consent flow from scratch.
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/html" },
        body: `<html><body style="font-family:sans-serif;padding:40px;">
          <h2>No refresh token was returned</h2>
          <p>This usually means a refresh token was already issued previously. Go to
          <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>,
          remove access for this app, then try connecting again from the start.</p>
        </body></html>`,
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html" },
      body: `<html><body style="font-family:sans-serif;padding:40px;max-width:700px;">
        <h2>✅ Connected to Google Drive</h2>
        <p>Copy the value below into the Netlify environment variable
        <code>GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN</code>, then trigger a new deploy.</p>
        <p style="background:#f1f5f9;padding:16px;border-radius:8px;word-break:break-all;font-family:monospace;">
          ${data.refresh_token}
        </p>
        <p style="color:#dc2626;">This is a real credential -- don't leave this page open longer than
        necessary, and don't share it anywhere except the Netlify env var.</p>
      </body></html>`,
    };
  } catch (error) {
    console.error("drive-oauth-callback error:", error);
    return { statusCode: 500, body: `Failed to complete Google Drive connection: ${error.message}` };
  }
};

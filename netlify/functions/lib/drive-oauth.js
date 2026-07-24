// netlify/functions/lib/drive-oauth.js
//
// Shared helper for getting a fresh Drive access token from the
// stored refresh token, used by both drive-upload.js and
// drive-file-proxy.js. Replaces the earlier service-account/JWT
// approach -- service accounts have no storage quota of their own
// (Google's own upload-time error confirms this), and Shared Drives/
// domain-wide delegation both require Google Workspace, which isn't
// available here (personal Google account only). OAuth-as-a-real-user
// uses that person's own 15GB Drive quota instead, at the cost of a
// one-time manual consent flow (see drive-oauth-callback.js) to
// obtain the refresh token in the first place.
//
// A refresh token itself doesn't expire (unless revoked, or unused
// for 6 months, or the OAuth consent screen stays in "Testing" mode
// for over 7 days without the app being published/verified -- worth
// knowing if this silently stops working after a week: the consent
// screen may need moving out of Testing mode, or its 7-day test-token
// expiry re-triggered by redoing the consent flow). Each API call
// still needs a short-lived access token, fetched fresh here every
// invocation rather than cached, since Netlify functions are
// stateless between invocations anyway.

const CLIENT_ID = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN;

async function getDriveAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Google Drive OAuth is not fully configured (missing client id/secret/refresh token).");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    // invalid_grant here most often means the refresh token was
    // revoked, or the OAuth consent screen's 7-day Testing-mode grant
    // expired -- both need redoing the one-time consent flow
    // (drive-oauth-callback.js) to get a new refresh token.
    throw new Error(data.error_description || data.error || "Failed to refresh Google Drive access token.");
  }
  return data.access_token;
}

module.exports = { getDriveAccessToken };

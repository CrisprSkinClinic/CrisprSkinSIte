// netlify/functions/drive-oauth-start.js
//
// Builds the Google OAuth consent URL server-side (where env vars are
// safe to reference) and redirects the browser to it. This replaces
// hardcoding GOOGLE_DRIVE_OAUTH_CLIENT_ID / _REDIRECT_URI directly
// into public/connect-drive.html -- Netlify's secrets scanner
// correctly flagged that as a real problem: those values, once
// committed into a static file that ships in the build output, are
// permanently in the repo's history and public dist folder, exactly
// the pattern secrets scanning exists to catch (even though the
// Client ID itself isn't sensitive, the redirect URI matching a
// stored secret's name still trips the scanner, and committing
// either value as a plain literal is the wrong pattern regardless).
//
// public/connect-drive.html's "Connect Google Drive" button now just
// links to /.netlify/functions/drive-oauth-start instead of building
// the Google URL client-side.

const CLIENT_ID = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
const REDIRECT_URI = process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  if (!CLIENT_ID || !REDIRECT_URI) {
    return { statusCode: 500, body: "Google Drive OAuth is not configured (missing client id/redirect URI env vars)." };
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline", // required to get a refresh_token back at all
    prompt: "consent", // forces a fresh refresh_token even on repeat connections
  });

  return {
    statusCode: 302,
    headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` },
    body: "",
  };
};

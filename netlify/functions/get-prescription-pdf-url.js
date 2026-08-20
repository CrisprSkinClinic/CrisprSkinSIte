// netlify/functions/get-prescription-pdf-url.js
//
// Mints a short-lived SIGNED URL (Supabase Storage's built-in
// mechanism for temporary access to a private object) for a
// prescription PDF, rather than ever making the file public. This is
// the function behind both "view PDF" in-app and an explicit "Share
// with patient" action -- same short-lived-link principle already
// used for Drive-hosted lab reports/photos, but even simpler here
// since Supabase Storage supports signed URLs natively (no need for
// a custom proxy function re-checking auth on every byte, unlike the
// Drive integration, which doesn't have an equivalent built-in).
//
// The signed URL itself expires on its own (default 1 hour here) --
// once expired, a new one must be minted through this same
// auth-gated endpoint, so access can't be extended indefinitely by
// just holding onto an old link.

const { createServiceRoleClient } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");

const STORAGE_BUCKET = "derm-rx-prescriptions";
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60; // 1 hour

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { supabase, errorResponse: clientError } = createServiceRoleClient();
  if (clientError) return clientError;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { accessToken, rxId } = payload || {};
  const { profile, errorResponse: authError } = await verifyStaffAuth(supabase, accessToken);
  if (authError) return authError;
  if (profile.role !== "doctor") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only doctor accounts can access prescription PDFs." }) };
  }
  if (!rxId) {
    return { statusCode: 400, body: JSON.stringify({ error: "rxId is required." }) };
  }

  try {
    const { data: rxRows, error: rxError } = await supabase.rpc("get_derm_rx_by_id", { p_rx_id: rxId });
    if (rxError) throw rxError;
    if (!rxRows || rxRows.length === 0 || !rxRows[0].pdf_url) {
      return { statusCode: 404, body: JSON.stringify({ error: "No PDF has been generated for this prescription yet." }) };
    }
    const storagePath = rxRows[0].pdf_url;

    const { data: signedData, error: signError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);
    if (signError) throw signError;

    return { statusCode: 200, body: JSON.stringify({ success: true, url: signedData.signedUrl, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS }) };
  } catch (error) {
    console.error("get-prescription-pdf-url error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Failed to get PDF link." }) };
  }
};

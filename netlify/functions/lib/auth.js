// netlify/functions/lib/auth.js
//
// Verifies a bookings-manager request's access token against real
// Supabase Auth (not a shared password), and loads the corresponding
// staff profile. Every action handler needs this before doing
// anything else -- pulled out here so the main router only calls it
// once per request instead of every module reimplementing the same
// check.

async function verifyStaffAuth(supabase, accessToken) {
  if (!accessToken) {
    return { errorResponse: { statusCode: 401, body: JSON.stringify({ error: "Missing access token. Please sign in again." }) } };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return { errorResponse: { statusCode: 401, body: JSON.stringify({ error: "Session expired or invalid. Please sign in again." }) } };
  }
  const authUserId = userData.user.id;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", authUserId)
    .single();
  if (profileError || !profile) {
    return { errorResponse: { statusCode: 403, body: JSON.stringify({ error: "No staff profile found for this account." }) } };
  }
  if (!profile.is_active) {
    return { errorResponse: { statusCode: 403, body: JSON.stringify({ error: "This staff account has been deactivated." }) } };
  }

  return { profile };
}

module.exports = { verifyStaffAuth };

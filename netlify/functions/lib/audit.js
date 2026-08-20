// netlify/functions/lib/audit.js
//
// Best-effort audit logging, shared by every action module. A failure
// here should never block the actual action from completing -- matches
// the original bookings-manager.js behavior ("if it fails, it fails,
// no local fallback") but without letting that failure cascade into
// the real operation failing too.

function makeLogAudit(supabase, profile) {
  return async function logAudit(actionName, details) {
    try {
      await supabase.from("booking_audit_log").insert({
        action: actionName,
        details,
        performed_by: profile.full_name,
        performed_by_profile_id: profile.id,
      });
    } catch (e) {
      console.error("Audit log write failed:", e);
    }
  };
}

module.exports = { makeLogAudit };

// netlify/functions/number-overview.js
//
// After the booker verifies their WhatsApp number, BookingCalendar.astro calls this to show
// "Patients on this number": each patient with their last consultation (so the same doctor
// can be pre-selected and the visit booked as a Review) and their upcoming visits at this
// clinic, with whether each can still be rescheduled or cancelled online.
//
// Requires the phone's verification token (checked, not used up), so nothing is shown to
// anyone but the number's owner.
//
// POST { phone, otpToken }

const core = require("./lib/booking-core.cjs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return core.json(405, { error: "Method Not Allowed" });
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return core.json(400, { error: "Invalid request body" });
  }
  const canonicalPhone = core.canonicalIndianMobile(payload.phone);
  if (!canonicalPhone || !payload.otpToken) return core.json(400, { error: "Verify your WhatsApp number first." });

  const { supabase, error: configError } = core.serviceClient();
  if (configError) return core.json(500, { error: "Booking is temporarily unavailable." });
  try {
    if (!(await core.tokenIsValid(supabase, canonicalPhone, payload.otpToken))) {
      return core.json(403, { error: "Your verification has expired. Please verify your WhatsApp number again.", expired: true });
    }
    return core.json(200, {
      patients: await core.numberOverview(supabase, canonicalPhone),
      maxPerDay: core.MAX_VISITS_PER_NUMBER_PER_DAY,
    });
  } catch (error) {
    console.error("number-overview error:", error.message);
    return core.json(500, { error: "Something went wrong. Please try again or call the clinic." });
  }
};

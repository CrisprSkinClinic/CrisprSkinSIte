// netlify/functions/public-returning-patient.js
//
// After the booker verifies their WhatsApp number (verify-booking-otp.js),
// BookingCalendar.astro calls this to:
//   - list the patients already registered on that number (for the
//     "booking for a family member" quick picks), and
//   - greet a returning patient with their last consultation and pre-select
//     that doctor, when the entered name matches one of them.
// Requires the unused verification token for this phone, so this information
// is only shown to the number's owner.

const core = require("./lib/booking-core");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return core.json(405, { error: "Method Not Allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return core.json(400, { error: "Invalid request body" });
  }

  const canonical = core.canonicalIndianMobile(payload.phone);
  const name = String(payload.name || "").trim();
  if (!canonical || !payload.otpToken) return core.json(400, { error: "Verified phone and verification token are required." });

  const { supabase, error: configError } = core.serviceClient();
  if (configError) return core.json(500, { error: "Patient lookup is temporarily unavailable." });

  try {
    if (!(await core.tokenIsValid(supabase, canonical, payload.otpToken))) {
      return core.json(403, { error: "Please verify your WhatsApp number again." });
    }
    const patientsOnNumber = (await core.patientsOnPhone(supabase, canonical)).map((p) => ({ name: p.name }));
    const last = core.normalizeName(name) ? await core.lastConsultation(supabase, canonical, name) : null;
    if (!last?.date) return core.json(200, { found: false, patientsOnNumber });
    return core.json(200, {
      found: true,
      patientsOnNumber,
      lastConsultation: { date: last.date, doctorId: last.doctorId, doctorName: last.doctorName },
    });
  } catch (error) {
    console.error("public-returning-patient error:", error.message);
    return core.json(500, { error: "Patient lookup is temporarily unavailable." });
  }
};

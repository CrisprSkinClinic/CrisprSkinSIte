// netlify/functions/review-context.js
//
// Backs the review booking page (/review) that the clinic's WhatsApp review reminder links to. After the patient
// verifies their WhatsApp number (send-booking-otp / verify-booking-otp) this returns:
//   - every patient registered on that number (family members often share one), and
//   - for the chosen patient: their visits in date order (past and upcoming), the one upcoming appointment if
//     there is one, and the doctor they last saw, so the page can pick that doctor automatically.
// Requires the phone's unused verification token (peeked, not used up), so this is only shown to the number's owner.
//
// POST { phone, otpToken, patientId? }

const core = require("./lib/booking-core");

const DONE = ["seen", "complete", "completed"];
const STATUS_LABEL = { seen: "Completed", complete: "Completed", completed: "Completed", no_show: "Did not attend", cancelled: "Cancelled", booked: "Booked", arrived: "Checked in" };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return core.json(405, { error: "Method Not Allowed" });
  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return core.json(400, { error: "Invalid request body" }); }

  const phone = core.canonicalIndianMobile(payload.phone);
  if (!phone || !payload.otpToken) return core.json(400, { error: "Verified phone and verification token are required." });
  const { supabase, error: configError } = core.serviceClient();
  if (configError) return core.json(500, { error: "Review booking is temporarily unavailable." });

  try {
    if (!(await core.tokenIsValid(supabase, phone, payload.otpToken))) {
      return core.json(403, { error: "Your verification has expired. Please verify your WhatsApp number again." });
    }
    const patients = (await core.patientsOnPhone(supabase, phone)).map((p) => ({ id: p.id, name: p.name }));
    if (!payload.patientId) return core.json(200, { patients });

    const patient = patients.find((p) => p.id === String(payload.patientId));
    if (!patient) return core.json(404, { error: "That patient is not on this number." });
    return core.json(200, { patients, selected: await patientView(supabase, patient) });
  } catch (error) {
    console.error("review-context error:", error.message);
    return core.json(500, { error: "Something went wrong. Please try again or call the clinic." });
  }
};

async function patientView(supabase, patient) {
  const { data, error } = await supabase
    .from("appointments")
    .select("id, doctor_id, slot_date, slot_time, status, linked_group_id, notes, doctors!appointments_doctor_id_fkey(name)")
    .eq("patient_id", patient.id)
    .in("doctor_id", core.CLINIC_DOCTOR_IDS)
    .is("deleted_at", null)
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });
  if (error) throw error;

  // A multi-slot reception booking is several rows sharing linked_group_id: show it once.
  const seen = new Set();
  const visits = [];
  for (const a of data || []) {
    const key = a.linked_group_id || a.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = String(a.notes || "").split("|").map((s) => s.trim()).filter(Boolean)[0];
    const past = core.isPast(a.slot_date, a.slot_time);
    // A booked slot whose time has gone, with nobody checking in, is not "upcoming" any more.
    const status = a.status === "booked" && past ? "no_show" : a.status;
    visits.push({
      id: a.id,
      date: a.slot_date,
      dateLabel: core.displayDate(a.slot_date, true),
      time: core.displayTime(a.slot_time),
      doctorId: a.doctor_id,
      doctorName: a.doctors?.name || null,
      type: kind === "Review" ? "Review" : "Consultation",
      status,
      statusLabel: STATUS_LABEL[status] || status,
      upcoming: ["booked", "arrived"].includes(a.status) && !past,
      canChange: core.canChangeOnline(a) && !past,
    });
  }
  const upcoming = visits.find((v) => v.upcoming) || null;
  const lastDone = [...visits].reverse().find((v) => DONE.includes(v.status));
  const lastAny = [...visits].reverse().find((v) => v.status !== "cancelled" && !v.upcoming);
  const doctorSource = lastDone || lastAny || null;
  return {
    id: patient.id,
    name: patient.name,
    visits: visits.slice(-30),
    upcoming,
    doctor: doctorSource?.doctorId ? { id: doctorSource.doctorId, name: doctorSource.doctorName } : null,
  };
}

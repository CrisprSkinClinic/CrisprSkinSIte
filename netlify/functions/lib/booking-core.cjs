// netlify/functions/lib/booking-core.cjs (.cjs so it loads as CommonJS whatever the site package.json says)
//
// Shared by the public booking functions (book, returning-patient, manage,
// OTP send/verify). Not a function itself: Netlify only deploys a folder as a
// function when it contains index.js or lib.js.
//
// Everything here talks to the AppointmentManager Supabase project with the
// service-role key, which never leaves the server.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

// This clinic's doctors (lib/clinic.cjs, the one file that differs between the websites).
const { CLINIC_DOCTOR_IDS } = require("./clinic.cjs");

// Online changes stop this close to the appointment; after that the patient calls the clinic.
const CHANGE_CUTOFF_MINUTES = 120;
// Visits one verified number can hold on one day at this clinic (all patients on it together).
const MAX_VISITS_PER_NUMBER_PER_DAY = 2;

// Maps JS Date#getUTCDay() (0 = Sunday) to slot_templates.day_of_week enum values.
const DAY_OF_WEEK_BY_INDEX = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

/** Returns { supabase, serviceRoleKey } or { error } when the server isn't configured. */
function serviceClient() {
  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient) return { error: "Server module @supabase/supabase-js failed to load." };
  if (!SUPABASE_URL) return { error: "APPOINTMENT_MANAGER_SUPABASE_URL environment variable is missing." };
  if (!serviceRoleKey) return { error: "APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY environment variable is missing." };
  // Node 20 on Netlify has no native WebSocket, which crashes Supabase's
  // Realtime client on init; nothing here uses Realtime.
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }
  return {
    supabase: createClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    serviceRoleKey,
  };
}

// WhatsApp codes and verification tokens are stored against a hash of the
// exact phone string, so every function must use this one form: "91" + 10 digits.
function canonicalIndianMobile(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : null;
}

// Patient identity is phone + name; ignore title, case and punctuation.
function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^(mr|mrs|ms|miss|dr|master|baby)\.?\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Normalizes "HH:MM", "HH:MM:SS" or "h:mm AM/PM" to "HH:MM:SS" for comparing
// against Postgres time columns.
function normalizeTime(t) {
  if (!t) return t;
  const ampm = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (ampm) {
    let hours = parseInt(ampm[1], 10);
    if (ampm[3].toUpperCase() === "PM" && hours !== 12) hours += 12;
    if (ampm[3].toUpperCase() === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:${ampm[2]}:00`;
  }
  return t.length === 5 ? `${t}:00` : t;
}

// "13:30:00" -> "1:30 PM"
function displayTime(t) {
  const [hh, mm] = String(t).split(":");
  const hour = parseInt(hh, 10);
  return `${((hour + 11) % 12) + 1}:${mm} ${hour >= 12 ? "PM" : "AM"}`;
}

// "2026-09-28" -> "28 September" (or "28 September 2026")
function displayDate(slotDate, withYear = false) {
  return new Date(`${slotDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  });
}

// Clinic (IST) date and "HH:MM:SS" right now.
function clinicNow() {
  const ist = new Date(Date.now() + 330 * 60000).toISOString();
  return { date: ist.slice(0, 10), time: ist.slice(11, 19) };
}

function isPast(slotDate, slotTime) {
  const now = clinicNow();
  return slotDate < now.date || (slotDate === now.date && slotTime <= now.time);
}

// Fisher-Yates shuffle, so a no-preference booking isn't biased toward the
// first doctor in CLINIC_DOCTOR_IDS.
function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * First candidate doctor (in the given order) who has a session covering the
 * slot, isn't on leave or blocked, and has capacity left. `ignoreAppointmentId`
 * leaves out an appointment being moved, so it doesn't count against itself.
 * Returns { doctorId } or { error }.
 */
async function findAvailableDoctor(supabase, { slotDate, slotTime, candidates, ignoreAppointmentId = null }) {
  const dayOfWeek = DAY_OF_WEEK_BY_INDEX[new Date(`${slotDate}T00:00:00Z`).getUTCDay()];
  if (!dayOfWeek || Number.isNaN(new Date(`${slotDate}T00:00:00Z`).getTime())) return { error: "Invalid date." };
  if (isPast(slotDate, slotTime)) return { error: "That time has already passed. Please choose a later slot." };
  if (!candidates.length) return { error: "No valid doctor candidates provided." };

  let lastFailureReason = "The selected time is outside available hours.";
  for (const candidateId of candidates) {
    const { data: overrides, error: overridesError } = await supabase
      .from("schedule_overrides")
      .select("*")
      .eq("doctor_id", candidateId)
      .eq("override_date", slotDate);
    if (overridesError) throw overridesError;

    if ((overrides || []).some((o) => o.override_type === "leave")) {
      lastFailureReason = "The selected doctor is not available on the selected date.";
      continue;
    }
    if ((overrides || []).some((o) => o.override_type === "blocked_slot" && normalizeTime(o.blocked_slot) === slotTime)) {
      lastFailureReason = "That time slot is unavailable on the selected date.";
      continue;
    }

    const modified = (overrides || []).find((o) => o.override_type === "modified");
    let inSession = false;
    let maxPerSlot = 1;
    if (modified) {
      inSession = Boolean(modified.modified_start && modified.modified_end &&
        slotTime >= normalizeTime(modified.modified_start) && slotTime < normalizeTime(modified.modified_end));
    } else {
      const { data: templates, error: templatesError } = await supabase
        .from("slot_templates")
        .select("*")
        .eq("doctor_id", candidateId)
        .eq("day_of_week", dayOfWeek)
        .eq("is_active", true);
      if (templatesError) throw templatesError;
      const template = (templates || []).find(
        (t) => slotTime >= normalizeTime(t.session_start) && slotTime < normalizeTime(t.session_end)
      );
      if (template) { inSession = true; maxPerSlot = template.max_per_slot || 1; }
    }
    if (!inSession) continue;

    let countQuery = supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("doctor_id", candidateId)
      .eq("slot_date", slotDate)
      .eq("slot_time", slotTime)
      .not("status", "in", "(cancelled)");
    if (ignoreAppointmentId) countQuery = countQuery.neq("id", ignoreAppointmentId);
    const { count, error: countError } = await countQuery;
    if (countError) throw countError;
    if ((count || 0) >= maxPerSlot) {
      lastFailureReason = "That time slot is already fully booked.";
      continue;
    }
    return { doctorId: candidateId };
  }
  return { error: lastFailureReason };
}

/** True when the token from verify-booking-otp is valid and unused for this phone (does not consume it). */
async function tokenIsValid(supabase, canonicalPhone, token) {
  if (!token) return false;
  const { data, error } = await supabase.rpc("service_peek_phone_otp_token", { p_phone: canonicalPhone, p_token: String(token) });
  if (error) {
    if (/uuid/i.test(error.message || "")) return false;
    throw error;
  }
  return Boolean(data);
}

/** Uses up the token; false if it was already used, expired or belongs to another phone. */
async function consumeToken(supabase, canonicalPhone, token) {
  const { data, error } = await supabase.rpc("service_consume_phone_otp_token", { p_phone: canonicalPhone, p_token: String(token) });
  if (error) {
    if (/uuid/i.test(error.message || "")) return false;
    throw error;
  }
  return Boolean(data);
}

/** Every patient registered on this phone: [{ id, name }]. Family members often share a number. */
async function patientsOnPhone(supabase, canonicalPhone) {
  const { data, error } = await supabase.rpc("service_find_patients_by_phone", { p_phone: canonicalPhone });
  if (error) throw error;
  return data || [];
}

/**
 * The patient on this phone whose name matches, with their last consultation
 * (a "seen" or "complete" visit up to today). Returns null when no patient
 * matches, or { patientId, date: null } when they have no past consultation.
 */
async function lastConsultation(supabase, canonicalPhone, name) {
  const patient = (await patientsOnPhone(supabase, canonicalPhone)).find((row) => normalizeName(row.name) === normalizeName(name));
  if (!patient) return null;
  return lastConsultationFor(supabase, patient.id);
}

/** A patient's last seen/completed consultation at this clinic: { patientId, date, doctorId, doctorName } (date null if none). */
async function lastConsultationFor(supabase, patientId) {
  const patient = { id: patientId };
  const { data: visit, error } = await supabase
    .from("appointments")
    .select("slot_date, doctor_id, doctors(name)")
    .eq("patient_id", patient.id)
    .in("doctor_id", CLINIC_DOCTOR_IDS)
    .lte("slot_date", clinicNow().date)
    .in("status", ["seen", "complete"])
    .is("deleted_at", null)
    .order("slot_date", { ascending: false })
    .order("slot_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!visit) return { patientId: patient.id, date: null };
  return { patientId: patient.id, date: visit.slot_date, doctorId: visit.doctor_id, doctorName: visit.doctors?.name || null };
}

/** The patient's first non-cancelled appointment at this clinic on a date, optionally ignoring one being moved. */
async function appointmentOnDay(supabase, patientId, slotDate, ignoreAppointmentId = null) {
  let q = supabase
    .from("appointments")
    .select("id, slot_date, slot_time, status, linked_group_id, doctor_id, notes, doctors(name)")
    .eq("patient_id", patientId)
    .in("doctor_id", CLINIC_DOCTOR_IDS)
    .eq("slot_date", slotDate)
    .neq("status", "cancelled")
    .is("deleted_at", null);
  if (ignoreAppointmentId) q = q.neq("id", ignoreAppointmentId);
  const { data, error } = await q.order("slot_time", { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

function minutesUntil(slotDate, slotTime) {
  return (Date.parse(`${slotDate}T${normalizeTime(slotTime)}+05:30`) - Date.now()) / 60000;
}

/**
 * Why an appointment can't be changed (rescheduled or cancelled) online, or null when it can:
 * only a plain single-slot booking the patient hasn't arrived for, more than
 * CHANGE_CUTOFF_MINUTES before it starts.
 */
function changeBlockReason(appointment) {
  if (appointment.status === "arrived") return "You're already checked in for this appointment.";
  if (appointment.status !== "booked") return "This appointment can't be changed online. Please call the clinic.";
  if (appointment.linked_group_id) return "This appointment was booked at the clinic. Please call the clinic to change it.";
  if (minutesUntil(appointment.slot_date, appointment.slot_time) < CHANGE_CUTOFF_MINUTES) {
    return "It's less than 2 hours to this appointment. Please call the clinic to change it.";
  }
  return null;
}

function canChangeOnline(appointment) {
  return !changeBlockReason(appointment);
}

/** Visits (a multi-slot visit counts once) the given patients hold at this clinic on a date. */
async function visitsOnDay(supabase, patientIds, slotDate, ignoreAppointmentId = null) {
  if (!patientIds.length) return 0;
  let q = supabase
    .from("appointments")
    .select("id, linked_group_id")
    .in("patient_id", patientIds)
    .in("doctor_id", CLINIC_DOCTOR_IDS)
    .eq("slot_date", slotDate)
    .neq("status", "cancelled")
    .is("deleted_at", null);
  if (ignoreAppointmentId) q = q.neq("id", ignoreAppointmentId);
  const { data, error } = await q;
  if (error) throw error;
  return new Set((data || []).map((a) => a.linked_group_id || a.id)).size;
}

function dailyLimitMessage(slotDate) {
  return `This number already has ${MAX_VISITS_PER_NUMBER_PER_DAY} appointments on ${displayDate(slotDate)}. Online booking allows ${MAX_VISITS_PER_NUMBER_PER_DAY} per number per day — please choose another day or call the clinic.`;
}

/** Upcoming, not-cancelled visits at this clinic for these patients, one entry per visit. */
async function upcomingVisits(supabase, patients) {
  if (!patients.length) return [];
  const nameById = new Map(patients.map((p) => [p.id, p.name]));
  const { data, error } = await supabase
    .from("appointments")
    .select("id, patient_id, doctor_id, slot_date, slot_time, status, linked_group_id, notes, doctors(name)")
    .in("patient_id", patients.map((p) => p.id))
    .in("doctor_id", CLINIC_DOCTOR_IDS)
    .gte("slot_date", clinicNow().date)
    .in("status", ["booked", "arrived"])
    .is("deleted_at", null)
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });
  if (error) throw error;
  const seen = new Set();
  const visits = [];
  for (const a of data || []) {
    if (isPast(a.slot_date, a.slot_time) && a.status === "booked") continue;
    const key = a.linked_group_id || a.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = String(a.notes || "").split("|").map((s) => s.trim()).filter(Boolean);
    const blocked = changeBlockReason(a);
    visits.push({
      id: a.id,
      patientId: a.patient_id,
      patientName: nameById.get(a.patient_id) || "Patient",
      date: a.slot_date,
      dateLabel: displayDate(a.slot_date, true),
      time: displayTime(a.slot_time),
      doctorId: a.doctor_id,
      doctorName: a.doctors?.name || null,
      service: parts[0] === "Review" ? `Review · ${parts[1] || "Consultation"}` : parts[0] || "Consultation",
      status: a.status,
      canChange: !blocked,
      changeNote: blocked,
    });
  }
  return visits;
}

/**
 * Everything the verified number's owner sees: each patient on the number with their last
 * consultation and upcoming visits at this clinic.
 */
async function numberOverview(supabase, canonicalPhone) {
  const patients = await patientsOnPhone(supabase, canonicalPhone);
  const [upcoming, lasts] = await Promise.all([
    upcomingVisits(supabase, patients),
    Promise.all(patients.map((p) => lastConsultationFor(supabase, p.id))),
  ]);
  return patients.map((p, i) => ({
    id: p.id,
    name: p.name,
    lastConsultation: lasts[i]?.date ? { date: lasts[i].date, dateLabel: displayDate(lasts[i].date, true), doctorId: lasts[i].doctorId, doctorName: lasts[i].doctorName } : null,
    upcoming: upcoming.filter((v) => v.patientId === p.id),
  }));
}

// Written to reception's audit trail. `action` uses reception's action names
// (APPOINTMENT_CREATE / APPOINTMENT_RESCHEDULE / APPOINTMENT_CANCEL).
async function logForReception(supabase, action, details) {
  const { error } = await supabase.from("booking_audit_log").insert({ action, details, performed_by: "Website (patient)", source_app: "website" });
  if (error) console.error("booking_audit_log insert failed:", error.message);
}

function appendNote(notes, note) {
  return String(notes || "").includes(note) ? notes : [notes, note].filter(Boolean).join(" | ");
}

/**
 * Sends the approved WhatsApp appointment confirmation via the
 * send-wa-appointment-confirmation Edge Function (Meta credentials stay in
 * Supabase). Best-effort: failures are logged, never thrown, because the
 * booking itself has already succeeded.
 */
async function sendConfirmation(supabase, { serviceRoleKey, canonicalPhone, name, doctorId, slotDate, slotTime, appointmentId }) {
  try {
    const { data: doctorRow, error: doctorLookupError } = await supabase.from("doctors").select("name").eq("id", doctorId).single();
    if (doctorLookupError) throw doctorLookupError;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-wa-appointment-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceRoleKey}` },
      body: JSON.stringify({
        phone: canonicalPhone,
        patient_name: name,
        doctor_name: doctorRow?.name ? `Dr. ${doctorRow.name}` : "your doctor",
        date: displayDate(slotDate, true),
        time: displayTime(slotTime),
        appointment_id: appointmentId,
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error("WhatsApp confirmation send failed:", errBody.error || res.status);
    }
  } catch (whatsappError) {
    console.error("WhatsApp confirmation send threw:", whatsappError.message);
  }
}

module.exports = {
  SUPABASE_URL,
  CLINIC_DOCTOR_IDS,
  json,
  serviceClient,
  canonicalIndianMobile,
  normalizeName,
  normalizeTime,
  displayTime,
  displayDate,
  clinicNow,
  isPast,
  shuffle,
  findAvailableDoctor,
  CHANGE_CUTOFF_MINUTES,
  MAX_VISITS_PER_NUMBER_PER_DAY,
  tokenIsValid,
  consumeToken,
  patientsOnPhone,
  lastConsultation,
  lastConsultationFor,
  appointmentOnDay,
  changeBlockReason,
  canChangeOnline,
  visitsOnDay,
  dailyLimitMessage,
  upcomingVisits,
  numberOverview,
  logForReception,
  appendNote,
  sendConfirmation,
};

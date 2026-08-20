// netlify/functions/lib/rx-queue.js
//
// Backend for the new /prescription landing screen: today's
// appointment queue for the signed-in doctor, plus a broader patient
// search (name or phone) as an alternative to clicking a queue row --
// replaces the old bare phone-number-only entry field, per the
// explicit redesign request ("naive UI... should fetch from the list
// of patients instead of typing a phone number").

const { ok } = require("./supabase-client");

async function getDoctorQueue(supabase, data) {
  if (!data?.doctorId) {
    return { statusCode: 400, body: JSON.stringify({ error: "doctorId is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("get_doctor_queue", {
    p_doctor_id: data.doctorId,
    p_date: data.date || new Date().toISOString().slice(0, 10),
  });
  if (error) throw error;
  return ok({ queue: rows });
}

async function searchPatients(supabase, data) {
  if (!data?.query || data.query.trim().length < 2) {
    return { statusCode: 400, body: JSON.stringify({ error: "A search query of at least 2 characters is required." }) };
  }
  const { data: rows, error } = await supabase.rpc("search_patients", { p_query: data.query.trim() });
  if (error) throw error;
  return ok({ patients: rows });
}

module.exports = { getDoctorQueue, searchPatients };

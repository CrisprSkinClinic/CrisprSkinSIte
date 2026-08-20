// netlify/functions/lib/schedule.js
//
// Weekly schedule (slot_templates) and exceptions/leave
// (schedule_overrides). No patient PII involved -- relocated here
// unchanged from the original single-file bookings-manager.js as
// part of splitting that file into modules.

const { ok } = require("./supabase-client");

async function listSchedule(supabase, data) {
  let query = supabase.from("slot_templates").select("*").order("day_of_week").order("session_start");
  if (data?.doctor_id) query = query.eq("doctor_id", data.doctor_id);
  const { data: rows, error } = await query;
  if (error) throw error;
  return ok({ sessions: rows });
}

async function addScheduleBlock(supabase, data, logAudit) {
  if (!data.doctor_id || !data.day_of_week || !data.start_time || !data.end_time) {
    return { statusCode: 400, body: JSON.stringify({ error: "doctor_id, day_of_week, start_time and end_time are all required." }) };
  }
  const { error } = await supabase.from("slot_templates").insert({
    doctor_id: data.doctor_id,
    day_of_week: data.day_of_week,
    session_start: data.start_time,
    session_end: data.end_time,
    max_per_slot: data.max_per_slot || 1,
    is_active: true,
  });
  if (error) throw error;
  await logAudit("SCHEDULE_CHANGE", `Added ${data.day_of_week} ${data.start_time}-${data.end_time} for doctor ${data.doctor_id}`);
  return ok({ success: true });
}

async function updateScheduleBlock(supabase, data, logAudit) {
  const { error } = await supabase
    .from("slot_templates")
    .update({ session_start: data.start_time, session_end: data.end_time })
    .eq("id", data.id);
  if (error) throw error;
  await logAudit("SCHEDULE_CHANGE", `Updated schedule block ${data.id}`);
  return ok({ success: true });
}

async function deleteScheduleBlock(supabase, data, logAudit) {
  const { error } = await supabase.from("slot_templates").delete().eq("id", data.id);
  if (error) throw error;
  await logAudit("SCHEDULE_CHANGE", `Removed schedule block ${data.id}`);
  return ok({ success: true });
}

async function listOverrides(supabase, data) {
  let query = supabase.from("schedule_overrides").select("*").order("override_date");
  if (data?.doctor_id) query = query.eq("doctor_id", data.doctor_id);
  const { data: rows, error } = await query;
  if (error) throw error;
  return ok({ overrides: rows });
}

async function addOverride(supabase, data, logAudit) {
  if (!data.doctor_id || !data.override_date || !data.override_type) {
    return { statusCode: 400, body: JSON.stringify({ error: "doctor_id, override_date and override_type are required." }) };
  }
  const insertRow = {
    doctor_id: data.doctor_id,
    override_date: data.override_date,
    override_type: data.override_type,
    reason: data.reason || null,
  };
  if (data.override_type === "modified") {
    insertRow.modified_start = data.modified_start;
    insertRow.modified_end = data.modified_end;
  }
  if (data.override_type === "blocked_slot") {
    insertRow.blocked_slot = data.blocked_slot;
  }
  const { error } = await supabase.from("schedule_overrides").insert(insertRow);
  if (error) throw error;
  await logAudit(
    "SCHEDULE_CHANGE",
    data.override_type === "leave"
      ? `Marked ${data.override_date} as leave for doctor ${data.doctor_id}`
      : `Added ${data.override_type} override on ${data.override_date} for doctor ${data.doctor_id}`
  );
  return ok({ success: true });
}

async function removeOverride(supabase, data, logAudit) {
  const { error } = await supabase.from("schedule_overrides").delete().eq("id", data.id);
  if (error) throw error;
  await logAudit("SCHEDULE_CHANGE", `Removed schedule override ${data.id}`);
  return ok({ success: true });
}

module.exports = {
  listSchedule,
  addScheduleBlock,
  updateScheduleBlock,
  deleteScheduleBlock,
  listOverrides,
  addOverride,
  removeOverride,
};

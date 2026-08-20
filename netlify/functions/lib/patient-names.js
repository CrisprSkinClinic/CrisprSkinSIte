// netlify/functions/lib/patient-names.js
//
// Batch-resolves patient_id -> decrypted {name, phone} for display,
// replacing the old PostgREST embed pattern
// (.select("*, patients(name, phone)")) which no longer works now that
// patients.name/phone are encrypted (name_enc/phone_enc) columns and
// can't be selected directly through an embed. Callers fetch rows with
// just patient_id, then call resolvePatientNames() once with all the
// ids involved (appointments list, payments list, etc.) rather than
// resolving one at a time.

// Returns a Map<patientId, {name, phone}> for the given ids. Missing
// or null ids are simply absent from the map -- callers should fall
// back to a placeholder (e.g. "patient") when a lookup comes up empty,
// same as the old code's `appt.patients?.name || "patient"` pattern.
async function resolvePatientNamesMap(supabase, patientIds) {
  const uniqueIds = [...new Set((patientIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const { data: rows, error } = await supabase.rpc("resolve_patient_names", { p_patient_ids: uniqueIds });
  if (error) throw error;

  const map = new Map();
  for (const row of rows || []) {
    map.set(row.id, { name: row.name, phone: row.phone });
  }
  return map;
}

// Convenience for the common single-patient case (e.g. building one
// audit-log message), so callers don't need the Map dance for just one id.
async function resolveSinglePatientName(supabase, patientId) {
  if (!patientId) return null;
  const map = await resolvePatientNamesMap(supabase, [patientId]);
  return map.get(patientId)?.name || null;
}

module.exports = { resolvePatientNamesMap, resolveSinglePatientName };

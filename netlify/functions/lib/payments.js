// netlify/functions/lib/payments.js
//
// Payments/reconciliation: record_payment, get_payment_for_appointment,
// list_payments_for_date, update_payment, delete_payment. Logic is
// otherwise unchanged from the original single-file bookings-manager.js
// -- the only changes are for encrypted patient PII:
//   - list_payments_for_date used to embed "patients(name)" directly;
//     that no longer works since patients.name is now encrypted
//     (name_enc). Now fetches patient_id and resolves names separately
//     via resolvePatientNamesMap().
//   - delete_payment used "patients(name)" purely to build an
//     audit-log message; replaced with resolveSinglePatientName().

const { ok } = require("./supabase-client");
const { resolvePatientNamesMap, resolveSinglePatientName } = require("./patient-names");

const VALID_CATEGORIES = ["consultation", "pharmacy", "lab", "vaccination", "procedure"];
const VALID_SUBTYPES = ["new", "review", "free"];
const VALID_MODES = ["cash", "card", "upi", "other"];

function validateLineItemsAndSplits(lineItems, splits) {
  let lineItemsTotal = 0;
  for (const item of lineItems) {
    if (!VALID_CATEGORIES.includes(item.category)) {
      return { error: `Invalid category: ${item.category}` };
    }
    if (item.category === "consultation") {
      if (!VALID_SUBTYPES.includes(item.consultationSubtype)) {
        return { error: "consultationSubtype (new/review/free) is required for a consultation line-item." };
      }
    } else if (item.consultationSubtype) {
      return { error: `consultationSubtype should not be set for a ${item.category} line-item.` };
    }
    if (typeof item.amount !== "number" || item.amount < 0) {
      return { error: "Each line-item needs a valid, non-negative amount." };
    }
    lineItemsTotal += item.amount;
  }

  let splitTotal = 0;
  for (const split of splits) {
    if (!VALID_MODES.includes(split.mode) || typeof split.amount !== "number" || split.amount <= 0) {
      return { error: "Each payment split needs a valid mode and a positive amount." };
    }
    splitTotal += split.amount;
  }

  // A visit that's ENTIRELY a free consultation (the only line-item)
  // has no splits at all. A visit with a free consultation ALONGSIDE
  // other paid categories (e.g. free consult + paid labs) still needs
  // splits covering the paid portion -- lineItemsTotal already reflects
  // that correctly since the free line-item contributes 0.
  if (lineItemsTotal === 0) {
    if (splits.length !== 0) {
      return { error: "A visit totaling ₹0 (e.g. entirely free) should have no payment splits." };
    }
  } else if (Math.abs(splitTotal - lineItemsTotal) > 0.01) {
    return { error: `Payment splits (₹${splitTotal}) must add up to the line-items total (₹${lineItemsTotal}).` };
  }

  return { lineItemsTotal };
}

async function recordPayment(supabase, data, profile, logAudit) {
  if ((!data?.patient_id && !data?.new_patient_name) || !Array.isArray(data.lineItems) || data.lineItems.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "A patient (existing patient_id or new_patient_name) and at least one category line-item are required." }) };
  }

  let resolvedPatientId = data.patient_id || null;
  if (!resolvedPatientId && data.new_patient_name) {
    const { data: newPatientId, error: newPatientErr } = await supabase.rpc("insert_patient_encrypted", {
      p_name: data.new_patient_name,
      p_phone: data.new_patient_phone || null,
      p_dob: null,
      p_gender: null,
      p_address: null,
      p_is_registered: false,
    });
    if (newPatientErr) throw newPatientErr;
    resolvedPatientId = newPatientId;
  }

  const splits = Array.isArray(data.splits) ? data.splits : [];
  const validation = validateLineItemsAndSplits(data.lineItems, splits);
  if (validation.error) {
    return { statusCode: 400, body: JSON.stringify({ error: validation.error }) };
  }
  const { lineItemsTotal } = validation;

  const { data: entry, error: entryError } = await supabase
    .from("payment_entries")
    .insert({
      appointment_id: data.appointment_id || null,
      patient_id: resolvedPatientId,
      total_amount: lineItemsTotal,
      collected_by: profile.id,
      notes: data.notes || null,
    })
    .select("id")
    .single();
  if (entryError) throw entryError;

  const { error: lineItemsError } = await supabase.from("payment_line_items").insert(
    data.lineItems.map((item) => ({
      payment_entry_id: entry.id,
      category: item.category,
      consultation_subtype: item.category === "consultation" ? item.consultationSubtype : null,
      amount: item.amount,
    }))
  );
  if (lineItemsError) throw lineItemsError;

  if (splits.length > 0) {
    const { error: splitsError } = await supabase
      .from("payment_splits")
      .insert(splits.map((s) => ({ payment_entry_id: entry.id, mode: s.mode, amount: s.amount })));
    if (splitsError) throw splitsError;
  }

  const categorySummary = data.lineItems.map((i) => (i.category === "consultation" ? `consultation (${i.consultationSubtype})` : i.category)).join(", ");
  await logAudit("CREATE", `Recorded ₹${lineItemsTotal} payment (${categorySummary}) for patient ${resolvedPatientId}`);
  return ok({ success: true, paymentId: entry.id });
}

async function getPaymentForAppointment(supabase, data) {
  if (!data?.appointment_id) {
    return { statusCode: 400, body: JSON.stringify({ error: "appointment_id is required." }) };
  }
  // An appointment could in principle have more than one payment
  // recorded against it over time (e.g. a correction), but the Record
  // Payment UI edits exactly one payment per appointment -- take the
  // most recent if somehow more than one exists, rather than erroring.
  const { data: entries, error } = await supabase
    .from("payment_entries")
    .select("*, payment_splits(mode, amount), payment_line_items(category, consultation_subtype, amount)")
    .eq("appointment_id", data.appointment_id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ok({ payment: entries && entries.length > 0 ? entries[0] : null });
}

async function listPaymentsForDate(supabase, data) {
  if (!data?.date) {
    return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
  }
  const startOfDay = `${data.date}T00:00:00.000Z`;
  const endOfDay = `${data.date}T23:59:59.999Z`;
  const { data: rows, error } = await supabase
    .from("payment_entries")
    .select(
      "*, collected_by_profile:profiles!payment_entries_collected_by_fkey(full_name), payment_splits(mode, amount), payment_line_items(category, consultation_subtype, amount)"
    )
    .gte("created_at", startOfDay)
    .lte("created_at", endOfDay)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const nameMap = await resolvePatientNamesMap(supabase, rows.map((r) => r.patient_id));
  const payments = rows.map((r) => ({
    ...r,
    patients: nameMap.has(r.patient_id) ? { name: nameMap.get(r.patient_id).name } : null,
  }));
  return ok({ payments });
}

async function updatePayment(supabase, data, logAudit) {
  // Edits an existing payment_entries row in place: updates the
  // parent's total/notes, then replaces its line-items and splits
  // entirely (delete + reinsert) rather than trying to diff and patch
  // individual rows, since a category can be added/removed/changed on
  // edit and reconciling that incrementally isn't worth the complexity
  // for what's still a simple payment log, not a full accounting ledger.
  if (!data?.paymentEntryId || !Array.isArray(data.lineItems) || data.lineItems.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "paymentEntryId and at least one category line-item are required." }) };
  }

  const splits = Array.isArray(data.splits) ? data.splits : [];
  const validation = validateLineItemsAndSplits(data.lineItems, splits);
  if (validation.error) {
    return { statusCode: 400, body: JSON.stringify({ error: validation.error }) };
  }
  const { lineItemsTotal } = validation;

  const { error: updateError } = await supabase
    .from("payment_entries")
    .update({ total_amount: lineItemsTotal, notes: data.notes || null })
    .eq("id", data.paymentEntryId);
  if (updateError) throw updateError;

  // Replace line-items and splits entirely.
  await supabase.from("payment_line_items").delete().eq("payment_entry_id", data.paymentEntryId);
  await supabase.from("payment_splits").delete().eq("payment_entry_id", data.paymentEntryId);

  const { error: lineItemsError } = await supabase.from("payment_line_items").insert(
    data.lineItems.map((item) => ({
      payment_entry_id: data.paymentEntryId,
      category: item.category,
      consultation_subtype: item.category === "consultation" ? item.consultationSubtype : null,
      amount: item.amount,
    }))
  );
  if (lineItemsError) throw lineItemsError;

  if (splits.length > 0) {
    const { error: splitsError } = await supabase
      .from("payment_splits")
      .insert(splits.map((s) => ({ payment_entry_id: data.paymentEntryId, mode: s.mode, amount: s.amount })));
    if (splitsError) throw splitsError;
  }

  await logAudit("UPDATE", `Updated payment entry ${data.paymentEntryId}: ₹${lineItemsTotal}`);
  return ok({ success: true });
}

async function deletePayment(supabase, data, logAudit) {
  const { data: payment, error: fetchErr } = await supabase
    .from("payment_entries")
    .select("total_amount, patient_id, payment_line_items(category)")
    .eq("id", data.id)
    .single();
  if (fetchErr) throw fetchErr;

  // payment_splits and payment_line_items rows cascade-delete
  // automatically (both have on delete cascade on payment_entry_id),
  // so only the parent needs deleting explicitly here.
  const { error } = await supabase.from("payment_entries").delete().eq("id", data.id);
  if (error) throw error;

  const categories = (payment.payment_line_items || []).map((li) => li.category).join(", ") || "unknown category";
  const patientName = await resolveSinglePatientName(supabase, payment.patient_id);
  await logAudit("DELETE", `Deleted ₹${payment.total_amount} payment entry (${categories}) for ${patientName || "patient"}`);
  return ok({ success: true });
}

module.exports = { recordPayment, getPaymentForAppointment, listPaymentsForDate, updatePayment, deletePayment };

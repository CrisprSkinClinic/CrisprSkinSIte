// netlify/functions/lib/cash.js
//
// Expenses (expense_entries) and daily cash session reconciliation
// (daily_cash_sessions, cash_recounts). No patient PII involved --
// relocated here unchanged from the original single-file
// bookings-manager.js as part of splitting that file into modules.

const { ok } = require("./supabase-client");

async function recordExpense(supabase, data, profile, logAudit) {
  if (!data?.category || !data?.amount) {
    return { statusCode: 400, body: JSON.stringify({ error: "category and amount are required." }) };
  }
  const validExpenseCategories = ["bank_deposit", "handed_to_doctor", "petty_expense", "other"];
  if (!validExpenseCategories.includes(data.category)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid expense category." }) };
  }
  const amountNum = Number(data.amount);
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Amount must be a positive number." }) };
  }
  const { data: expense, error } = await supabase
    .from("expense_entries")
    .insert({ category: data.category, amount: amountNum, notes: data.notes || null, recorded_by: profile.id })
    .select("id")
    .single();
  if (error) throw error;

  await logAudit("CREATE", `Recorded expense: ₹${amountNum} (${data.category})`);
  return ok({ success: true, expenseId: expense.id });
}

async function listExpensesForDate(supabase, data) {
  if (!data?.date) {
    return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
  }
  const startOfDay = `${data.date}T00:00:00.000Z`;
  const endOfDay = `${data.date}T23:59:59.999Z`;
  const { data: expenses, error } = await supabase
    .from("expense_entries")
    .select("*, recorded_by_profile:profiles!expense_entries_recorded_by_fkey(full_name)")
    .gte("created_at", startOfDay)
    .lte("created_at", endOfDay)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ok({ expenses });
}

async function deleteExpense(supabase, data, logAudit) {
  const { error } = await supabase.from("expense_entries").delete().eq("id", data.id);
  if (error) throw error;
  await logAudit("DELETE", `Deleted expense entry ${data.id}`);
  return ok({ success: true });
}

async function getCashSession(supabase, data) {
  if (!data?.date) {
    return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
  }
  const { data: session, error } = await supabase
    .from("daily_cash_sessions")
    .select("*")
    .eq("session_date", data.date)
    .maybeSingle();
  if (error) throw error;

  // Also surface the previous calendar day's closing total, so the
  // frontend can flag a mismatch between yesterday's close and today's
  // opening count -- a common sign the till wasn't actually reconciled
  // properly overnight.
  const prevDate = new Date(`${data.date}T00:00:00Z`);
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDateStr = prevDate.toISOString().slice(0, 10);
  const { data: prevSession } = await supabase
    .from("daily_cash_sessions")
    .select("closing_total")
    .eq("session_date", prevDateStr)
    .maybeSingle();

  return ok({ session: session || null, previousClosingTotal: prevSession?.closing_total ?? null });
}

async function recordCashOpening(supabase, data, profile, logAudit) {
  if (!data?.date) {
    return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
  }
  const counts = {
    opening_count_50: Number(data.count50) || 0,
    opening_count_100: Number(data.count100) || 0,
    opening_count_200: Number(data.count200) || 0,
    opening_count_500: Number(data.count500) || 0,
  };
  const openingTotal = counts.opening_count_50 * 50 + counts.opening_count_100 * 100 + counts.opening_count_200 * 200 + counts.opening_count_500 * 500;

  const { error } = await supabase.from("daily_cash_sessions").upsert(
    {
      session_date: data.date,
      ...counts,
      opening_total: openingTotal,
      opening_recorded_by: profile.id,
      opening_recorded_at: new Date().toISOString(),
    },
    { onConflict: "session_date" }
  );
  if (error) throw error;

  await logAudit("CREATE", `Recorded opening cash count for ${data.date}: ₹${openingTotal}`);
  return ok({ success: true, openingTotal });
}

async function recordCashClosing(supabase, data, profile, logAudit) {
  if (!data?.date) {
    return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
  }
  const { data: existingSession, error: fetchErr } = await supabase
    .from("daily_cash_sessions")
    .select("opening_total")
    .eq("session_date", data.date)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!existingSession || existingSession.opening_total === null) {
    return { statusCode: 400, body: JSON.stringify({ error: "Opening cash count must be recorded before closing for this date." }) };
  }

  const counts = {
    closing_count_50: Number(data.count50) || 0,
    closing_count_100: Number(data.count100) || 0,
    closing_count_200: Number(data.count200) || 0,
    closing_count_500: Number(data.count500) || 0,
  };
  const closingTotal = counts.closing_count_50 * 50 + counts.closing_count_100 * 100 + counts.closing_count_200 * 200 + counts.closing_count_500 * 500;

  // expected_closing = opening + cash payments today - cash expenses today
  const startOfDay = `${data.date}T00:00:00.000Z`;
  const endOfDay = `${data.date}T23:59:59.999Z`;
  const { data: cashSplits } = await supabase
    .from("payment_splits")
    .select("amount, payment_entries!inner(created_at)")
    .eq("mode", "cash")
    .gte("payment_entries.created_at", startOfDay)
    .lte("payment_entries.created_at", endOfDay);
  const cashCollected = (cashSplits || []).reduce((sum, s) => sum + Number(s.amount), 0);

  const { data: cashExpenses } = await supabase
    .from("expense_entries")
    .select("amount")
    .gte("created_at", startOfDay)
    .lte("created_at", endOfDay);
  const expensesTotal = (cashExpenses || []).reduce((sum, e) => sum + Number(e.amount), 0);

  const expectedClosing = Number(existingSession.opening_total) + cashCollected - expensesTotal;
  const discrepancy = closingTotal - expectedClosing;

  const { error } = await supabase
    .from("daily_cash_sessions")
    .update({
      ...counts,
      closing_total: closingTotal,
      closing_recorded_by: profile.id,
      closing_recorded_at: new Date().toISOString(),
      expected_closing: expectedClosing,
      discrepancy,
    })
    .eq("session_date", data.date);
  if (error) throw error;

  await logAudit(
    "UPDATE",
    `Recorded closing cash count for ${data.date}: ₹${closingTotal} (expected ₹${expectedClosing.toFixed(2)}, discrepancy ₹${discrepancy.toFixed(2)})`
  );
  return ok({ success: true, closingTotal, expectedClosing, discrepancy });
}

async function recordCashRecount(supabase, data, profile) {
  if (!data?.date) {
    return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
  }
  const count50 = Number(data.count50) || 0;
  const count100 = Number(data.count100) || 0;
  const count200 = Number(data.count200) || 0;
  const count500 = Number(data.count500) || 0;
  const countedTotal = count50 * 50 + count100 * 100 + count200 * 200 + count500 * 500;

  const { error } = await supabase.from("cash_recounts").insert({
    session_date: data.date,
    count_50: count50,
    count_100: count100,
    count_200: count200,
    count_500: count500,
    counted_total: countedTotal,
    recorded_by: profile.id,
  });
  if (error) throw error;

  return ok({ success: true, countedTotal });
}

async function listCashRecounts(supabase, data) {
  if (!data?.date) {
    return { statusCode: 400, body: JSON.stringify({ error: "date is required." }) };
  }
  const { data: recounts, error } = await supabase
    .from("cash_recounts")
    .select("*, recorded_by_profile:profiles!cash_recounts_recorded_by_fkey(full_name)")
    .eq("session_date", data.date)
    .order("recorded_at", { ascending: true });
  if (error) throw error;
  return ok({ recounts });
}

module.exports = {
  recordExpense,
  listExpensesForDate,
  deleteExpense,
  getCashSession,
  recordCashOpening,
  recordCashClosing,
  recordCashRecount,
  listCashRecounts,
};

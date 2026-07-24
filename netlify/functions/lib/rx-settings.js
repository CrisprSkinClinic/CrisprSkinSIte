// netlify/functions/lib/rx-settings.js
//
// CRUD actions for the derm_rx_* master-data tables (medicines,
// templates, dx protocols, billing master) -- backs the Settings
// screen in /prescription. Added because the user chose to start
// with zero seed data and build the medicine list/templates/dx
// protocols organically through a real UI, rather than seeding
// placeholder data upfront (which risked looking like real clinical
// guidance if anyone mistook it for such).

const { ok } = require("./supabase-client");

// ---- Medicines ----
async function listMedicines(supabase) {
  const { data, error } = await supabase.rpc("list_derm_rx_medicines");
  if (error) throw error;
  return ok({ medicines: data });
}

async function upsertMedicine(supabase, data) {
  if (!data?.name) {
    return { statusCode: 400, body: JSON.stringify({ error: "Medicine name is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_derm_rx_medicine", {
    p_name: data.name.trim(),
    p_suggested_dosages: data.suggestedDosages || null,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function deleteMedicine(supabase, data) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("delete_derm_rx_medicine", { p_id: data.id });
  if (error) throw error;
  return ok({ success: true });
}

// ---- Templates ----
async function listTemplates(supabase) {
  const { data, error } = await supabase.rpc("list_derm_rx_templates");
  if (error) throw error;
  return ok({ templates: data });
}

async function upsertTemplate(supabase, data) {
  if (!data?.templateType || !["clinical", "meds", "advice", "labs"].includes(data.templateType)) {
    return { statusCode: 400, body: JSON.stringify({ error: "templateType must be clinical, meds, advice, or labs." }) };
  }
  if (!data?.name) {
    return { statusCode: 400, body: JSON.stringify({ error: "Template name is required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_derm_rx_template", {
    p_id: data.id || null,
    p_template_type: data.templateType,
    p_name: data.name.trim(),
    p_data: data.data ?? {},
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function deleteTemplate(supabase, data) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("delete_derm_rx_template", { p_id: data.id });
  if (error) throw error;
  return ok({ success: true });
}

// ---- Dx protocols ----
async function listDxProtocols(supabase) {
  const { data, error } = await supabase.rpc("list_derm_rx_dx_protocols");
  if (error) throw error;
  return ok({ protocols: data });
}

async function upsertDxProtocol(supabase, data) {
  if (!data?.keyword || !Array.isArray(data.suggestedMedicines) || data.suggestedMedicines.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "keyword and at least one suggested medicine are required." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_derm_rx_dx_protocol", {
    p_keyword: data.keyword.trim(),
    p_suggested_medicines: data.suggestedMedicines,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function deleteDxProtocol(supabase, data) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("delete_derm_rx_dx_protocol", { p_id: data.id });
  if (error) throw error;
  return ok({ success: true });
}

// ---- Billing master ----
async function listBillingItems(supabase) {
  const { data, error } = await supabase.rpc("list_derm_rx_billing_items");
  if (error) throw error;
  return ok({ items: data });
}

async function upsertBillingItem(supabase, data) {
  if (!data?.serviceType || !data?.name || data.price === undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: "serviceType, name, and price are required." }) };
  }
  const priceNum = Number(data.price);
  if (Number.isNaN(priceNum) || priceNum < 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "price must be a non-negative number." }) };
  }
  const { data: id, error } = await supabase.rpc("upsert_derm_rx_billing_item", {
    p_id: data.id || null,
    p_service_type: data.serviceType.trim(),
    p_name: data.name.trim(),
    p_price: priceNum,
    p_gst_rate: Number(data.gstRate) || 0,
  });
  if (error) throw error;
  return ok({ success: true, id });
}

async function deleteBillingItem(supabase, data) {
  if (!data?.id) return { statusCode: 400, body: JSON.stringify({ error: "id is required." }) };
  const { error } = await supabase.rpc("delete_derm_rx_billing_item", { p_id: data.id });
  if (error) throw error;
  return ok({ success: true });
}

module.exports = {
  listMedicines,
  upsertMedicine,
  deleteMedicine,
  listTemplates,
  upsertTemplate,
  deleteTemplate,
  listDxProtocols,
  upsertDxProtocol,
  deleteDxProtocol,
  listBillingItems,
  upsertBillingItem,
  deleteBillingItem,
};

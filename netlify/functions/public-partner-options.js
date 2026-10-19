// netlify/functions/public-partner-options.js
//
// Drop-down data for /partner-register: the clinic's distributor (stockist) names and the companies and divisions it already
// knows. Names only; service_partner_form_options_v1 returns nothing sensitive.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method Not Allowed" };
  const url = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
  const key = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!createClient || !url || !key) return { statusCode: 500, body: JSON.stringify({ error: "Server is not configured correctly." }) };
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }
  try {
    const { data, error } = await createClient(url, key).rpc("service_partner_form_options_v1");
    if (error) throw error;
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }, body: JSON.stringify({ distributors: data?.distributors || [], companies: data?.companies || [] }) };
  } catch (e) {
    console.error("public-partner-options error:", e);
    return { statusCode: 500, body: JSON.stringify({ error: "Could not load the lists." }) };
  }
};

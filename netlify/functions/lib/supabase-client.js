// netlify/functions/lib/supabase-client.js
//
// Shared service-role Supabase client creation for all bookings-manager
// modules. Centralized here so the WebSocket shim (needed because
// Netlify's Node runtime doesn't provide a global WebSocket, which the
// supabase-js realtime client otherwise expects) and env var checks
// only need to exist once.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;

function ensureWebSocketShim() {
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      constructor() {}
      close() {}
      send() {}
    };
  }
}

// Returns { supabase } on success, or { errorResponse } if the module
// or env vars aren't available -- callers check errorResponse first.
function createServiceRoleClient() {
  if (!createClient) {
    return { errorResponse: { statusCode: 500, body: JSON.stringify({ error: "Server module @supabase/supabase-js failed to load." }) } };
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { errorResponse: { statusCode: 500, body: JSON.stringify({ error: "Supabase environment variables are missing." }) } };
  }
  ensureWebSocketShim();
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  return { supabase };
}

function ok(body, statusCode = 200) {
  return { statusCode, body: JSON.stringify(body) };
}

module.exports = { createServiceRoleClient, ok };

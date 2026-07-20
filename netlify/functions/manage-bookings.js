// netlify/functions/manage-bookings.js
//
// Server-side function for staff-admin to read/write Supabase booking
// and schedule data. Uses the Supabase service role key (server-side
// only, never exposed to the browser) so it can bypass RLS safely --
// access is gated entirely by the ADMIN_PASSWORD check below.

let createClient;
try {
  createClient = require("@supabase/supabase-js").createClient;
} catch (importError) {
  console.error("Failed to import @supabase/supabase-js:", importError);
}

const SUPABASE_URL = "https://tvvknokblzmjxlixdqce.supabase.co";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { password, action, data } = payload;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect password" }) };
  }

  if (!createClient) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server module @supabase/supabase-js failed to load." }),
    };
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "SUPABASE_SERVICE_ROLE_KEY environment variable is missing." }),
    };
  }

  // Provide a no-op WebSocket constructor so Supabase's Realtime client
  // can initialize without crashing, even though we never actually use
  // realtime features in this function. Works around Node 20's lack of
  // native WebSocket support on Netlify's runtime.
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket {
      constructor() {}
      close() {}
      send() {}
    };
  }

  const supabase = createClient(SUPABASE_URL, serviceRoleKey);

  try {
    switch (action) {
      case "list_appointments": {
        const { data: rows, error } = await supabase
          .from("appointments")
          .select("*")
          .order("appointment_date", { ascending: true })
          .order("appointment_time", { ascending: true });
        if (error) throw error;
        return ok({ appointments: rows });
      }

      case "cancel_appointment": {
        const { error } = await supabase
          .from("appointments")
          .update({ status: "cancelled" })
          .eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      // ---- Schedule sessions (replaces old per-slot weekly_schedule) ----

      case "list_schedule_sessions": {
        const { data: rows, error } = await supabase
          .from("schedule_sessions")
          .select("*")
          .order("day_of_week", { ascending: true })
          .order("start_time", { ascending: true });
        if (error) throw error;
        return ok({ sessions: rows });
      }

      case "add_schedule_session": {
        const { error } = await supabase.from("schedule_sessions").insert({
          day_of_week: data.day_of_week,
          start_time: data.start_time,
          end_time: data.end_time,
          slot_duration_minutes: data.slot_duration_minutes,
          is_active: true,
        });
        if (error) throw error;
        return ok({ success: true });
      }

      case "toggle_schedule_session": {
        const { error } = await supabase
          .from("schedule_sessions")
          .update({ is_active: data.is_active })
          .eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      case "delete_schedule_session": {
        const { error } = await supabase.from("schedule_sessions").delete().eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      // ---- Blocked dates ----

      case "list_blocked_dates": {
        const { data: rows, error } = await supabase
          .from("blocked_dates")
          .select("*")
          .order("blocked_date", { ascending: true });
        if (error) throw error;
        return ok({ blockedDates: rows });
      }

      case "add_blocked_date": {
        const { error } = await supabase
          .from("blocked_dates")
          .insert({ blocked_date: data.blocked_date, reason: data.reason || null });
        if (error) throw error;
        return ok({ success: true });
      }

      case "remove_blocked_date": {
        const { error } = await supabase.from("blocked_dates").delete().eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      // ---- Blocked slots ----

      case "list_blocked_slots": {
        const { data: rows, error } = await supabase
          .from("blocked_slots")
          .select("*")
          .order("blocked_date", { ascending: true });
        if (error) throw error;
        return ok({ blockedSlots: rows });
      }

      case "add_blocked_slot": {
        const { error } = await supabase
          .from("blocked_slots")
          .insert({ blocked_date: data.blocked_date, time_slot: data.time_slot, reason: data.reason || null });
        if (error) throw error;
        return ok({ success: true });
      }

      case "remove_blocked_slot": {
        const { error } = await supabase.from("blocked_slots").delete().eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
    }
  } catch (error) {
    console.error("manage-bookings error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Something went wrong.",
        debug: { name: error.name, stack: error.stack?.split("\n").slice(0, 3) },
      }),
    };
  }
};

function ok(body) {
  return { statusCode: 200, body: JSON.stringify(body) };
}

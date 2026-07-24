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

// Read from env var (matching public-available-slots.js / public-book-appointment.js)
// rather than hardcoding a project URL -- this was previously hardcoded to a
// different clinic's own Supabase project, which would have silently pointed
// this clinic's admin booking manager at someone else's database.
// Set APPOINTMENT_MANAGER_SUPABASE_URL in Netlify env vars.
const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;

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

  const serviceRoleKey = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY environment variable is missing." }),
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
        // appointments has no first_name/last_name/service_type columns of
        // its own -- patient name/phone live on the patients table
        // (joined via patient_id), and the service booked is stored as
        // part of the free-text `notes` field (see public-book-appointment.js,
        // which writes "<service> | Email: ... | Booked via website
        // self-service" into notes at booking time) rather than a
        // dedicated column.
        let query = supabase
          .from("appointments")
          .select("*, patients(name, phone), doctors(name)")
          .order("slot_date", { ascending: true })
          .order("slot_time", { ascending: true });
        if (data && data.doctor_id) {
          query = query.eq("doctor_id", data.doctor_id);
        }
        const { data: rows, error } = await query;
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

      // ---- Weekly schedule (slot_templates) ----
      // Renamed from the previous schedule_sessions/start_time/end_time
      // naming, which never matched the actual AppointmentManager schema
      // (verified directly via SQL against the live database -- the real
      // table is slot_templates, with session_start/session_end columns,
      // scoped per doctor_id since this clinic has three doctors rather
      // than the single-doctor eye clinic this admin panel was originally
      // built for).

      case "list_schedule_sessions": {
        let query = supabase
          .from("slot_templates")
          .select("*")
          .order("day_of_week", { ascending: true })
          .order("session_start", { ascending: true });
        if (data && data.doctor_id) {
          query = query.eq("doctor_id", data.doctor_id);
        }
        const { data: rows, error } = await query;
        if (error) throw error;
        return ok({ sessions: rows });
      }

      case "add_schedule_session": {
        if (!data.doctor_id) {
          return { statusCode: 400, body: JSON.stringify({ error: "doctor_id is required to add a schedule session." }) };
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
        return ok({ success: true });
      }

      case "toggle_schedule_session": {
        const { error } = await supabase
          .from("slot_templates")
          .update({ is_active: data.is_active })
          .eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      case "delete_schedule_session": {
        const { error } = await supabase.from("slot_templates").delete().eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      // ---- Schedule overrides (leave days, blocked slots, modified hours) ----
      // The real AppointmentManager schema uses one schedule_overrides
      // table with an override_type column ('leave' | 'blocked_slot' |
      // 'modified'), not the separate blocked_dates/blocked_slots tables
      // this function previously assumed -- those tables never actually
      // existed in the live database. Verified directly via SQL against
      // the live schema before writing this.

      case "list_blocked_dates": {
        let query = supabase
          .from("schedule_overrides")
          .select("*")
          .eq("override_type", "leave")
          .order("override_date", { ascending: true });
        if (data && data.doctor_id) {
          query = query.eq("doctor_id", data.doctor_id);
        }
        const { data: rows, error } = await query;
        if (error) throw error;
        return ok({ blockedDates: rows });
      }

      case "add_blocked_date": {
        if (!data.doctor_id) {
          return { statusCode: 400, body: JSON.stringify({ error: "doctor_id is required to block a date." }) };
        }
        const { error } = await supabase
          .from("schedule_overrides")
          .insert({
            doctor_id: data.doctor_id,
            override_date: data.blocked_date,
            override_type: "leave",
            reason: data.reason || null,
          });
        if (error) throw error;
        return ok({ success: true });
      }

      case "remove_blocked_date": {
        const { error } = await supabase.from("schedule_overrides").delete().eq("id", data.id);
        if (error) throw error;
        return ok({ success: true });
      }

      case "list_blocked_slots": {
        let query = supabase
          .from("schedule_overrides")
          .select("*")
          .eq("override_type", "blocked_slot")
          .order("override_date", { ascending: true });
        if (data && data.doctor_id) {
          query = query.eq("doctor_id", data.doctor_id);
        }
        const { data: rows, error } = await query;
        if (error) throw error;
        return ok({ blockedSlots: rows });
      }

      case "add_blocked_slot": {
        if (!data.doctor_id) {
          return { statusCode: 400, body: JSON.stringify({ error: "doctor_id is required to block a slot." }) };
        }
        const { error } = await supabase
          .from("schedule_overrides")
          .insert({
            doctor_id: data.doctor_id,
            override_date: data.blocked_date,
            override_type: "blocked_slot",
            blocked_slot: data.time_slot,
            reason: data.reason || null,
          });
        if (error) throw error;
        return ok({ success: true });
      }

      case "remove_blocked_slot": {
        const { error } = await supabase.from("schedule_overrides").delete().eq("id", data.id);
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

// netlify/functions/backup-database.js
//
// Scheduled (daily) backup of every table's data across the whole
// shared Supabase project (both derm-site and CRIS ClinicOS tables --
// user's explicit choice to back up everything rather than
// selectively, since a project-level disaster wouldn't distinguish
// between the two). Exports each table's full row data as JSON,
// bundles into one file per run, uploads to Google Drive.
//
// This is a DATA backup, not a schema/pg_dump backup -- a real
// pg_dump can't be run from a Netlify function (no shell access to
// the pg_dump binary), and the alternative (Supabase's Management
// API) was explicitly rejected as less secure (needs a
// high-privilege project-admin token) and less future-proof
// (Supabase-specific, undocumented-for-this-use endpoint) compared to
// this approach, which is just "query tables, write JSON" -- fully
// portable to any future database. The function/RPC DEFINITIONS
// (the ~40 SECURITY DEFINER functions built across this project)
// are NOT included here -- those already live safely in the git
// repo's migration history and the delivered code zips, so the
// higher-value, higher-risk thing to protect on a recurring
// unattended schedule is the DATA, not logic that's already
// versioned elsewhere.
//
// Netlify scheduled functions run via a cron expression configured in
// netlify.toml (see that file's [functions."backup-database"]
// schedule setting) -- this file's handler runs the same whether
// triggered by the schedule or manually invoked for testing.

const { createClient } = require("@supabase/supabase-js");
const { getDriveAccessToken } = require("./lib/drive-oauth");

const SUPABASE_URL = process.env.APPOINTMENT_MANAGER_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.APPOINTMENT_MANAGER_SUPABASE_SERVICE_ROLE_KEY;
const BACKUP_FOLDER_ID = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;

// All 78 public-schema tables as of this backup's creation (see the
// derm-clinic-website memory note / chat history for the query used
// to enumerate these). If new tables are added later, this list needs
// updating -- there's no way to introspect "all tables" generically
// through the anon/service-role client the same way a raw SQL
// connection could, without an extra RPC exposing that, which felt
// like unnecessary surface area for a backup script to carry.
const TABLES_TO_BACKUP = [
  "appointments", "attendance_corrections", "attendance_logs", "bill_counter", "bill_items", "bills",
  "booking_audit_log", "branches", "cash_recounts", "clinic_settings", "contact_lens_rx",
  "daily_cash_sessions", "daily_collection_summary", "department_billing_rules", "departments",
  "derm_rx_billing_master", "derm_rx_draft_bills", "derm_rx_dx_protocols", "derm_rx_exam_templates",
  "derm_rx_lab_orders", "derm_rx_medicine_batches", "derm_rx_medicines", "derm_rx_photos",
  "derm_rx_prescriptions", "derm_rx_templates", "doctor_price_overrides", "doctors",
  "expense_categories", "expense_entries", "expenses", "external_labs", "fundus_findings",
  "glasses_rx", "glasses_rx_lines", "iop_entries", "keratometry_entries", "lab_counter",
  "lab_order_items", "lab_orders", "lab_tests", "leave_applications", "leave_balances", "leave_types",
  "medicine_batches", "medicine_margins", "medicine_stock", "medicines", "monthly_pl",
  "near_vision_entries", "notification_log", "ophtho_investigations", "ophtho_macros", "ophtho_visits",
  "patient_intake_forms", "patient_registration_requests", "patients", "payment_entries",
  "payment_line_items", "payment_splits", "payroll_items", "payroll_months", "pharmacy_dispense_items",
  "pharmacy_dispenses", "po_counter", "prescription_items", "prescriptions", "profiles",
  "purchase_order_items", "purchase_orders", "push_subscriptions", "recurring_expenses",
  "refraction_entries", "schedule_overrides", "service_departments", "services", "slit_lamp_findings",
  "slot_templates", "staff_details", "supplier_outstanding", "suppliers", "uhid_counter",
];

async function uploadToDrive(accessToken, folderId, fileName, content) {
  const boundary = "db_backup_boundary_" + Date.now();
  const metadata = { name: fileName, parents: [folderId] };
  const fileBuffer = Buffer.from(content, "utf8");
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipartBody,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Drive upload failed.");
  return data.id;
}

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("backup-database: missing Supabase env vars.");
    return { statusCode: 500, body: "Server misconfigured." };
  }
  if (!BACKUP_FOLDER_ID) {
    console.error("backup-database: missing GOOGLE_DRIVE_BACKUP_FOLDER_ID.");
    return { statusCode: 500, body: "Server misconfigured." };
  }
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoOpWebSocket { constructor() {} close() {} send() {} };
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const backup = { exportedAt: new Date().toISOString(), tables: {}, errors: [] };

  // Sequential, not parallel -- keeps this well within Supabase's
  // connection/rate limits for what's meant to be a background job,
  // not a latency-sensitive user-facing request.
  for (const table of TABLES_TO_BACKUP) {
    try {
      const { data, error } = await supabase.from(table).select("*");
      if (error) throw error;
      backup.tables[table] = data;
    } catch (err) {
      // One table failing (e.g. renamed/dropped since this list was
      // written) shouldn't abort the entire backup -- record the
      // failure and keep going, so a partial backup still beats no
      // backup at all.
      backup.errors.push({ table, error: err.message });
    }
  }

  try {
    const driveToken = await getDriveAccessToken();
    const fileName = `db-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const fileId = await uploadToDrive(driveToken, BACKUP_FOLDER_ID, fileName, JSON.stringify(backup));
    console.log(`backup-database: uploaded ${fileName} (Drive file id ${fileId}), ${backup.errors.length} table errors.`);
    return { statusCode: 200, body: JSON.stringify({ success: true, fileId, fileName, tableErrors: backup.errors }) };
  } catch (error) {
    console.error("backup-database: Drive upload failed:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

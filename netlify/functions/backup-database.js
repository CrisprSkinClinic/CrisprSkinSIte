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

// Table list is fetched LIVE from Postgres on every run (via
// list_all_public_tables, a SECURITY DEFINER RPC querying
// information_schema.tables) rather than hardcoded here -- a fixed
// list would silently go stale the moment any new table is added,
// either by this codebase or by CRIS ClinicOS independently (which
// shares this database and isn't necessarily visible to changes made
// here). This also naturally excludes VIEWS (e.g.
// daily_collection_summary, medicine_margins) since those are derived
// from other tables' data, not their own stored rows -- nothing to
// back up there that isn't already covered by backing up their
// underlying tables.

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

  let tablesToBackup;
  try {
    const { data: tableRows, error: tableListError } = await supabase.rpc("list_all_public_tables");
    if (tableListError) throw tableListError;
    tablesToBackup = (tableRows || []).map((r) => r.table_name);
  } catch (err) {
    console.error("backup-database: failed to fetch live table list:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Could not determine which tables to back up: " + err.message }) };
  }

  // Sequential, not parallel -- keeps this well within Supabase's
  // connection/rate limits for what's meant to be a background job,
  // not a latency-sensitive user-facing request.
  for (const table of tablesToBackup) {
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

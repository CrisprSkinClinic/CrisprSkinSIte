// netlify/functions/restore-database.js
//
// Restores table data from a backup-database.js JSON export, found by
// filename in the Drive backup folder. INSERT-ONLY by design (never
// updates or deletes existing rows) -- this was an explicit choice
// over a wipe-and-replace restore, since a destructive restore mode
// sitting behind a live app endpoint is a real risk (a stray click,
// bug, or compromised session could destroy everything created since
// the backup) for essentially no benefit in the actual disaster-
// recovery scenario this exists for: restoring into a freshly
// created, empty database, where insert-only and wipe-and-replace
// produce an identical result anyway since there's nothing to
// conflict with.
//
// Requires signed-in doctor auth, same as every other sensitive
// action in this system -- restoring data is at least as
// consequential as writing it in the first place.

const { createServiceRoleClient } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");
const { getDriveAccessToken } = require("./lib/drive-oauth");

const BACKUP_FOLDER_ID = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;

// Most tables use a simple `id` primary key, but a few don't --
// verified directly against the live schema rather than assumed.
// Leaving onConflict unspecified for these would silently produce
// wrong behavior (Supabase's default conflict target assumption
// wouldn't match the table's actual PK), so each exception is called
// out explicitly here rather than trusting a blanket default.
const PRIMARY_KEY_OVERRIDES = {
  department_billing_rules: "department_id",
  service_departments: "department_id,service_id",
};

function primaryKeyFor(table) {
  return PRIMARY_KEY_OVERRIDES[table] || "id";
}

async function findFileInDrive(accessToken, folderId, fileName) {
  const query = encodeURIComponent(`name = '${fileName}' and '${folderId}' in parents and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Drive search failed.");
  return data.files && data.files[0] ? data.files[0].id : null;
}

async function downloadFromDrive(accessToken, fileId) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Failed to download file from Drive.");
  return response.text();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  if (!BACKUP_FOLDER_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "GOOGLE_DRIVE_BACKUP_FOLDER_ID is not configured." }) };
  }

  const { supabase, errorResponse: clientError } = createServiceRoleClient();
  if (clientError) return clientError;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { accessToken, fileName, dryRun } = payload || {};
  const { profile, errorResponse: authError } = await verifyStaffAuth(supabase, accessToken);
  if (authError) return authError;
  if (profile.role !== "doctor") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only doctor accounts can run a restore." }) };
  }
  if (!fileName) {
    return { statusCode: 400, body: JSON.stringify({ error: "fileName is required (e.g. db-backup-2026-07-24.json)." }) };
  }

  try {
    const driveToken = await getDriveAccessToken();
    const fileId = await findFileInDrive(driveToken, BACKUP_FOLDER_ID, fileName);
    if (!fileId) {
      return { statusCode: 404, body: JSON.stringify({ error: `No file named "${fileName}" found in the backup folder.` }) };
    }

    const rawContent = await downloadFromDrive(driveToken, fileId);
    const backup = JSON.parse(rawContent);
    if (!backup.tables) {
      return { statusCode: 400, body: JSON.stringify({ error: "This file doesn't look like a valid database backup (missing tables)." }) };
    }

    const results = [];
    for (const [table, rows] of Object.entries(backup.tables)) {
      if (!Array.isArray(rows) || rows.length === 0) {
        results.push({ table, rowsInBackup: 0, rowsInserted: 0, skipped: 0, error: null });
        continue;
      }

      if (dryRun) {
        // Preview mode: report what WOULD happen without writing
        // anything, so the person running this can see row counts
        // per table before committing to a real restore.
        results.push({ table, rowsInBackup: rows.length, rowsInserted: null, skipped: null, error: null, dryRun: true });
        continue;
      }

      // upsert with ignoreDuplicates achieves the insert-only
      // semantics described above: rows whose primary key already
      // exists are silently left untouched (not updated), rows that
      // don't exist yet are inserted. This relies on the backup
      // having included each table's real primary key values (which
      // it does, since backup-database.js exports select("*")).
      try {
        const { error, count } = await supabase.from(table).upsert(rows, { onConflict: primaryKeyFor(table), ignoreDuplicates: true, count: "exact" });
        if (error) throw error;
        results.push({ table, rowsInBackup: rows.length, rowsInserted: count ?? null, skipped: rows.length - (count ?? 0), error: null });
      } catch (err) {
        results.push({ table, rowsInBackup: rows.length, rowsInserted: 0, skipped: 0, error: err.message });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, backupExportedAt: backup.exportedAt, dryRun: !!dryRun, results }),
    };
  } catch (error) {
    console.error("restore-database error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Restore failed." }) };
  }
};

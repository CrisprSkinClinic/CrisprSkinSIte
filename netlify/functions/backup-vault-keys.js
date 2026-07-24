// netlify/functions/backup-vault-keys.js
//
// One-time (or rarely-repeated) export of the Vault encryption keys
// (pii_encryption_key, phone_hash_key) that decrypt every patient's
// PII in this database. Deliberately NOT part of the automated daily
// backup (backup-database.js) -- exporting these keys is the single
// highest-stakes action in the whole backup system, so it stays a
// manual, explicit, password-gated action rather than something that
// runs silently on a schedule.
//
// The keys are encrypted with a password ONLY the user knows (using
// Node's built-in crypto, AES-256-GCM) before ever leaving this
// function -- the file that lands in Drive is unreadable without that
// password, even to someone with full access to the Drive account.
// The password itself is never stored anywhere by this system; if
// it's forgotten, the backup file becomes permanently undecryptable
// (this is fundamental to how the protection works, not a bug -- the
// same tradeoff as any password-based encryption).
//
// Requires the same staff auth as every other write action here
// (doctor role), matching the principle that this is exactly as
// sensitive as everything else gated that way -- arguably more so.

const { createServiceRoleClient } = require("./lib/supabase-client");
const { verifyStaffAuth } = require("./lib/auth");
const { getDriveAccessToken } = require("./lib/drive-oauth");
const crypto = require("crypto");

const BACKUP_FOLDER_ID = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;

function encryptWithPassword(plaintextObj, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store salt/iv/authTag alongside the ciphertext (all safe to store
  // in plaintext -- only the password itself is the secret) so the
  // restore process has everything it needs from this one file.
  return Buffer.concat([salt, iv, authTag, encrypted]).toString("base64");
}

async function uploadToDrive(accessToken, folderId, fileName, content) {
  const boundary = "vault_backup_boundary_" + Date.now();
  const metadata = { name: fileName, parents: [folderId] };
  const fileBuffer = Buffer.from(content, "utf8");
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: text/plain\r\n\r\n`),
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

  const { accessToken, password } = payload || {};
  const { profile, errorResponse: authError } = await verifyStaffAuth(supabase, accessToken);
  if (authError) return authError;
  if (profile.role !== "doctor") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only doctor accounts can export encryption keys." }) };
  }
  if (!password || password.length < 12) {
    return { statusCode: 400, body: JSON.stringify({ error: "A password of at least 12 characters is required to encrypt this export." }) };
  }

  try {
    const { data: keys, error } = await supabase.rpc("export_vault_keys_for_backup");
    if (error) throw error;
    if (!keys || keys.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "No Vault keys found to export." }) };
    }

    const keysObj = {};
    keys.forEach((k) => { keysObj[k.name] = k.decrypted_secret; });

    const encryptedPayload = encryptWithPassword(
      { exportedAt: new Date().toISOString(), keys: keysObj },
      password
    );

    const driveToken = await getDriveAccessToken();
    const fileName = `vault-keys-backup-${new Date().toISOString().slice(0, 10)}.txt`;
    const fileId = await uploadToDrive(driveToken, BACKUP_FOLDER_ID, fileName, encryptedPayload);

    return { statusCode: 200, body: JSON.stringify({ success: true, fileId, fileName }) };
  } catch (error) {
    console.error("backup-vault-keys error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Failed to export vault keys." }) };
  }
};

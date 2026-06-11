#!/usr/bin/env node
/**
 * Operator fallback: register a workspace's webhook with a key that IS
 * allowed to manage webhooks (e.g. the master key), without that key ever
 * entering the app's database.
 *
 * Usage:
 *   ZERNIO_ADMIN_KEY=... node scripts/register-webhook.mjs <workspace-id> <public-app-url>
 *
 * Reads Supabase admin credentials from .env.local (local) / environment.
 * Generates the capability token + HMAC secret, registers the webhook with
 * Zernio, and stores { sha256(token), encrypted secret, webhook id } on the
 * workspace row. Prints the webhook URL ONCE — Zernio keeps it; we only keep
 * the hash.
 */
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const file of [".env.local", ".env"]) {
  const p = resolve(__dirname, "..", file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const [workspaceId, appUrl] = process.argv.slice(2);
const adminKey = process.env.ZERNIO_ADMIN_KEY;

if (!workspaceId || !appUrl || !adminKey) {
  console.error("Usage: ZERNIO_ADMIN_KEY=... node scripts/register-webhook.mjs <workspace-id> <public-app-url>");
  process.exit(1);
}
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "APP_ENCRYPTION_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} is not set`);
    process.exit(1);
  }
}

// Same enc:v1 format as lib/crypto.ts (kept in sync — this script must not
// import TS from the app).
function encryptSecret(plaintext, aad) {
  const key = Buffer.from(process.env.APP_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["enc", "v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: ws, error: wsErr } = await supabase
  .from("workspaces")
  .select("id, name, zernio_webhook_id")
  .eq("id", workspaceId)
  .maybeSingle();
if (wsErr || !ws) {
  console.error(`workspace not found: ${wsErr?.message ?? workspaceId}`);
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const secret = randomBytes(32).toString("base64url");
const url = `${appUrl.replace(/\/$/, "")}/api/webhooks/zernio/${token}`;

const { default: Zernio } = await import("@zernio/node");
const zernio = new Zernio({ apiKey: adminKey });

if (ws.zernio_webhook_id) {
  try {
    await zernio.webhooks.deleteWebhookSettings({ query: { id: ws.zernio_webhook_id } });
    console.log(`deleted previous webhook ${ws.zernio_webhook_id}`);
  } catch {
    console.warn("previous webhook could not be deleted (may already be gone)");
  }
}

const res = await zernio.webhooks.createWebhookSettings({
  body: { name: `zernflow-${workspaceId.slice(0, 8)}`, url, secret, events: ["message.received"] },
});
const webhookId = res.data?.webhook?._id;
if (!webhookId) {
  console.error("webhook creation returned no id");
  process.exit(1);
}

const { error: saveErr } = await supabase
  .from("workspaces")
  .update({
    webhook_token_hash: createHash("sha256").update(token).digest("hex"),
    webhook_secret_encrypted: encryptSecret(secret, workspaceId),
    zernio_webhook_id: webhookId,
  })
  .eq("id", workspaceId);

if (saveErr) {
  console.error(`credentials failed to save (${saveErr.message}) — rolling back webhook`);
  try {
    await zernio.webhooks.deleteWebhookSettings({ query: { id: webhookId } });
  } catch {
    console.error(`ROLLBACK FAILED: delete webhook ${webhookId} manually in the Zernio dashboard`);
  }
  process.exit(1);
}

console.log(`webhook registered for workspace "${ws.name}" (${workspaceId})`);
console.log(`  webhook id: ${webhookId}`);
console.log(`  url: ${url}`);
console.log("The URL token is stored only as a hash — note the URL if you need it again.");

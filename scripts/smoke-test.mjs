#!/usr/bin/env node
/**
 * ZernFlow end-to-end smoke test (hardened webhook contract).
 *
 * Against a RUNNING app (next dev or deployed):
 *   1. Mints a webhook token+secret for the target workspace (restored after)
 *   2. Creates a test channel + published keyword flow
 *   3. Sends an UNSIGNED webhook  -> expects 401, no writes
 *   4. Sends a SIGNED webhook     -> expects 200; contact + conversation +
 *      flow session created
 *   5. REPLAYS the same event     -> expects 200 {duplicate:true}, no dupes
 *   6. Cleans up all test data and restores the previous webhook credentials
 *
 * Usage:
 *   node scripts/smoke-test.mjs [base-url] [workspace-id]
 *   node scripts/smoke-test.mjs http://localhost:3000
 */
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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

const BASE_URL = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
let workspaceId = process.argv[3];

for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "APP_ENCRYPTION_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} is not set (run scripts/dev-env.mjs first)`);
    process.exit(1);
  }
}

function encryptSecret(plaintext, aad) {
  const key = Buffer.from(process.env.APP_ENCRYPTION_KEY, "base64");
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

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── target workspace ─────────────────────────────────────────────────────────
if (!workspaceId) {
  const { data } = await supabase.from("workspaces").select("id, name").limit(1).single();
  if (!data) {
    console.error("no workspace found — sign up in the app first");
    process.exit(1);
  }
  workspaceId = data.id;
  console.log(`workspace: ${data.name} (${workspaceId})`);
}

const { data: prev } = await supabase
  .from("workspaces")
  .select("webhook_token_hash, webhook_secret_encrypted, zernio_webhook_id")
  .eq("id", workspaceId)
  .single();

const token = randomBytes(32).toString("base64url");
const secret = randomBytes(32).toString("base64url");
const accountId = `smoke-acc-${randomUUID()}`;
const created = { channelId: null, flowId: null, triggerId: null, contactIds: [] };

try {
  // ── setup ──────────────────────────────────────────────────────────────────
  await supabase
    .from("workspaces")
    .update({
      webhook_token_hash: createHash("sha256").update(token).digest("hex"),
      webhook_secret_encrypted: encryptSecret(secret, workspaceId),
    })
    .eq("id", workspaceId);

  const { data: channel } = await supabase
    .from("channels")
    .insert({
      workspace_id: workspaceId,
      platform: "telegram",
      late_account_id: accountId,
      username: "smoke_test_bot",
      is_active: true,
    })
    .select("id")
    .single();
  created.channelId = channel.id;

  const sendNodeId = `node-${randomUUID()}`;
  const triggerNodeId = `node-${randomUUID()}`;
  const { data: flow } = await supabase
    .from("flows")
    .insert({
      workspace_id: workspaceId,
      name: `Smoke Test Flow ${Date.now()}`,
      status: "published",
      nodes: [
        { id: triggerNodeId, type: "trigger", data: { triggerType: "keyword" }, position: { x: 0, y: 0 } },
        { id: sendNodeId, type: "sendMessage", data: { messages: [{ text: "smoke reply" }] }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: triggerNodeId, target: sendNodeId }],
    })
    .select("id")
    .single();
  created.flowId = flow.id;

  const { data: trigger } = await supabase
    .from("triggers")
    .insert({
      flow_id: flow.id,
      channel_id: channel.id,
      type: "keyword",
      config: { keywords: [{ value: "smoketest", matchType: "exact" }] },
      is_active: true,
    })
    .select("id")
    .single();
  created.triggerId = trigger.id;

  // ── payload ────────────────────────────────────────────────────────────────
  const senderId = `smoke-sender-${randomUUID()}`;
  const payload = {
    id: `smoke-evt-${randomUUID()}`,
    event: "message.received",
    message: {
      id: `m-${randomUUID()}`,
      conversationId: `smoke-conv-${randomUUID()}`,
      platform: "telegram",
      platformMessageId: `pm-${randomUUID()}`,
      direction: "inbound",
      text: "smoketest",
      attachments: [],
      sender: { id: senderId, name: "Smoke Tester", username: null, picture: null },
      sentAt: new Date().toISOString(),
      isRead: false,
    },
    conversation: {
      id: `smoke-conv-${randomUUID()}`,
      platformConversationId: null,
      participantId: senderId,
      participantName: "Smoke Tester",
      participantUsername: null,
      participantPicture: null,
      status: "open",
    },
    account: { id: accountId, platform: "telegram", username: "smoke_test_bot", displayName: "Smoke Bot" },
    timestamp: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);
  const url = `${BASE_URL}/api/webhooks/zernio/${token}`;
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

  // ── 1. unsigned -> 401 ─────────────────────────────────────────────────────
  console.log("\nunsigned delivery:");
  const unsigned = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
  check("unsigned webhook rejected with 401", unsigned.status === 401, `got ${unsigned.status}`);

  // ── 2. signed -> processed ─────────────────────────────────────────────────
  console.log("signed delivery:");
  const signed = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zernio-signature": signature },
    body: rawBody,
  });
  check("signed webhook accepted with 200", signed.status === 200, `got ${signed.status}`);

  const { data: cc } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", created.channelId)
    .eq("platform_sender_id", senderId)
    .maybeSingle();
  check("contact created", !!cc);
  if (cc) created.contactIds.push(cc.contact_id);

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("channel_id", created.channelId)
    .maybeSingle();
  check("conversation created", !!conv);

  const { data: sessions } = await supabase
    .from("flow_sessions")
    .select("id, status")
    .eq("flow_id", created.flowId);
  check("flow session executed", (sessions?.length ?? 0) === 1);

  // ── 3. replay -> dedupe ────────────────────────────────────────────────────
  console.log("replayed delivery:");
  const replay = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zernio-signature": signature },
    body: rawBody,
  });
  const replayBody = await replay.json().catch(() => ({}));
  check("replay returns 200 duplicate", replay.status === 200 && replayBody.duplicate === true);

  const { count: contactCount } = await supabase
    .from("contact_channels")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", created.channelId);
  check("replay did not duplicate the contact", contactCount === 1, `count=${contactCount}`);
} finally {
  // ── cleanup ────────────────────────────────────────────────────────────────
  console.log("\ncleanup:");
  if (created.channelId) {
    await supabase.from("conversations").delete().eq("channel_id", created.channelId);
  }
  for (const contactId of created.contactIds) {
    await supabase.from("contacts").delete().eq("id", contactId);
  }
  if (created.channelId) {
    await supabase.from("channels").delete().eq("id", created.channelId);
  }
  if (created.flowId) {
    await supabase.from("flows").delete().eq("id", created.flowId); // cascades triggers/sessions
  }
  await supabase.from("webhook_events").delete().eq("workspace_id", workspaceId).like("event_id", "smoke-evt-%");
  await supabase
    .from("workspaces")
    .update({
      webhook_token_hash: prev?.webhook_token_hash ?? null,
      webhook_secret_encrypted: prev?.webhook_secret_encrypted ?? null,
      zernio_webhook_id: prev?.zernio_webhook_id ?? null,
    })
    .eq("id", workspaceId);
  console.log("  test data removed, webhook credentials restored");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

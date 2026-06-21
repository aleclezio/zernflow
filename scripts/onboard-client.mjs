#!/usr/bin/env node
/**
 * Operator CLI: stand up a full ZernFlow client tenant in one command.
 *
 * Thin HTTP client over POST /api/admin/onboard-client — the route runs the
 * lib/onboard.ts engine, so the CLI, the admin route, and the command-centre
 * "Add client" button all share ONE implementation and can never diverge.
 *
 * Secrets are read from the environment (never argv — argv leaks into shell
 * history and `ps`):
 *   ONBOARD_ADMIN_TOKEN   admin bearer for the route (required)
 *   CLIENT_ZERNIO_KEY     the client's (ideally profile-scoped) Zernio key (required)
 *   ZERNIO_ADMIN_KEY      key used to REGISTER the webhook (optional; scoped keys
 *                         often can't — set this to your master key for reliable
 *                         webhook registration)
 *   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   CF Access service token (optional;
 *                         required when the endpoint is behind Cloudflare Access)
 *   APP_URL               public app base, e.g. https://os.lygge.com/engage
 *                         (or pass --app-url)
 *
 * Usage:
 *   ONBOARD_ADMIN_TOKEN=... CLIENT_ZERNIO_KEY=... \
 *     node scripts/onboard-client.mjs --name "Acme" --owner <userId> \
 *       [--operator <userId>] [--profile <zernioProfileId>] [--slug acme] \
 *       [--key-name onboarding] [--scopes read,send] [--app-url https://os.lygge.com/engage]
 *
 * The issued scoped key is printed ONCE — store it immediately.
 */
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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const baseUrl = (args["app-url"] || process.env.APP_URL || "").replace(/\/$/, "");
const adminToken = process.env.ONBOARD_ADMIN_TOKEN;
const clientZernioKey = process.env.CLIENT_ZERNIO_KEY;

const missing = [];
if (!args.name) missing.push("--name");
if (!args.owner) missing.push("--owner <ownerUserId>");
if (!baseUrl) missing.push("--app-url (or APP_URL)");
if (!adminToken) missing.push("ONBOARD_ADMIN_TOKEN (env)");
if (!clientZernioKey) missing.push("CLIENT_ZERNIO_KEY (env)");
if (missing.length) {
  console.error("Missing required input(s):\n  " + missing.join("\n  "));
  console.error("\nRun with --help for usage.");
  process.exit(1);
}
if (args.help) {
  console.log("See the header of scripts/onboard-client.mjs for usage.");
  process.exit(0);
}

const body = {
  name: String(args.name),
  ownerUserId: String(args.owner),
  zernioApiKey: clientZernioKey,
  appUrl: baseUrl,
};
if (args.operator) body.operatorUserId = String(args.operator);
if (args.profile) body.profileId = String(args.profile);
if (args.slug) body.slug = String(args.slug);
if (args["key-name"]) body.keyName = String(args["key-name"]);
if (args.scopes) body.keyScopes = String(args.scopes).split(",").map((s) => s.trim()).filter(Boolean);
if (process.env.ZERNIO_ADMIN_KEY) body.webhookZernioKey = process.env.ZERNIO_ADMIN_KEY;

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${adminToken}`,
  // Explicit UA: Cloudflare's bot-protection (error 1010) blocks default
  // runtime user-agents before CF Access runs (see the worker bridge fix).
  "user-agent": "zernflow-onboard-cli/1.0",
};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}

const endpoint = `${baseUrl}/api/admin/onboard-client`;
console.log(`Onboarding "${body.name}" via ${endpoint} ...`);

let res;
try {
  res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
} catch (e) {
  console.error(`Request failed: ${e.message}`);
  process.exit(1);
}

const text = await res.text();
let out;
try {
  out = JSON.parse(text);
} catch {
  console.error(`Non-JSON response (HTTP ${res.status}). First 200 chars:\n${text.slice(0, 200)}`);
  process.exit(1);
}

if (!res.ok) {
  console.error(`Onboarding failed (HTTP ${res.status}): ${out.error || "unknown"}${out.step ? ` [step: ${out.step}]` : ""}`);
  process.exit(1);
}

const issuedKey = out.apiKey?.key;
const summary = { ...out, apiKey: { ...out.apiKey, key: issuedKey ? "<shown below>" : undefined } };
console.log("\nDone:");
console.log(JSON.stringify(summary, null, 2));

if (issuedKey) {
  console.log("\n──────────────────────────────────────────────");
  console.log("Scoped API key (shown ONCE — store it now):");
  console.log(`  ${issuedKey}`);
  console.log("──────────────────────────────────────────────");
} else {
  console.log("\nNo new key issued (a key with that name already exists — rotate it in Settings if you need a fresh secret).");
}
if (out.webhook && out.webhook.ok === false) {
  console.log(`\nNote: webhook not registered — ${out.webhook.warning || "registration failed"}`);
  console.log("Set ZERNIO_ADMIN_KEY and re-run, or use scripts/register-webhook.mjs with an authorized key.");
}

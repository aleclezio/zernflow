import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { anonClient, serviceClient, createTestUser } from "./helpers";

// Same seam as v1-parity: session path → mock-settable session client; API-key
// path → real service client (which bypasses RLS, so .eq(workspace_id) is the
// only tenant boundary). Scope enforcement lives in authorizeApiV1.
const state = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.session ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

// Representative routes per scope: read (flows GET), write (flows POST),
// send (messages POST + broadcasts/send POST).
import { GET as flowsGET, POST as flowsPOST } from "@/app/api/v1/flows/route";
import { GET as flowGET } from "@/app/api/v1/flows/[flowId]/route";
import { POST as messagesPOST } from "@/app/api/v1/messages/route";
import { POST as broadcastSend } from "@/app/api/v1/broadcasts/[broadcastId]/send/route";
import { _resetRateLimits } from "@/lib/rate-limit";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Seed a key with explicit scopes; omit `scopes` to exercise the DB full-access default (legacy key). */
async function seedKey(workspaceId: string, raw: string, createdBy: string, scopes?: string[]) {
  const { error } = await serviceClient()
    .from("api_keys")
    .insert({
      workspace_id: workspaceId,
      name: "scope test key",
      key_hash: sha256(raw),
      key_prefix: raw.slice(0, 12) + "...",
      created_by: createdBy,
      ...(scopes ? { scopes } : {}),
    });
  expect(error).toBeNull();
}

const URL = "http://localhost/api/v1/_";
const get = (raw: string, qs = "") =>
  new NextRequest(`${URL}${qs}`, { headers: { authorization: `Bearer ${raw}` } });
const post = (raw: string, body: unknown) =>
  new NextRequest(URL, {
    method: "POST",
    headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Seed a flow + broadcast + conversation so the per-scope routes have something to hit. */
async function seedWorkspace(workspaceId: string) {
  const svc = serviceClient();
  const { data: flow } = await svc
    .from("flows")
    .insert({ workspace_id: workspaceId, name: "wsflow", status: "draft", version: 1, nodes: [{ id: "n1" }], edges: [] })
    .select("id")
    .single();
  const { data: contact } = await svc
    .from("contacts")
    .insert({ workspace_id: workspaceId, display_name: `c-${workspaceId.slice(0, 6)}` })
    .select("id")
    .single();
  const { data: broadcast } = await svc
    .from("broadcasts")
    .insert({ workspace_id: workspaceId, name: `b-${workspaceId.slice(0, 6)}`, message_content: {} })
    .select("id")
    .single();
  const { data: channel } = await svc
    .from("channels")
    .insert({ workspace_id: workspaceId, platform: "instagram", late_account_id: `acc-${randomUUID()}`, is_active: true })
    .select("id")
    .single();
  const { data: conversation } = await svc
    .from("conversations")
    .insert({
      workspace_id: workspaceId,
      channel_id: channel!.id,
      contact_id: contact!.id,
      platform: "instagram",
      late_conversation_id: `late-${randomUUID()}`,
    })
    .select("id")
    .single();
  return { flowId: flow!.id, broadcastId: broadcast!.id, conversationId: conversation!.id };
}

// Distinct raw keys (distinct hashes) covering each scope grant.
const KEY_READ = "zf_scoperead0000000000000000000a";
const KEY_WRITE = "zf_scopewrite000000000000000000a";
const KEY_SEND = "zf_scopesend0000000000000000000a";
const KEY_FULL = "zf_scopefull0000000000000000000a"; // legacy — no scopes column set
const KEY_B = "zf_scopeB0000000000000000000000a";

let A: { workspaceId: string; userId: string } & Awaited<ReturnType<typeof seedWorkspace>>;
let B: { workspaceId: string } & Awaited<ReturnType<typeof seedWorkspace>>;

beforeAll(async () => {
  const ownerA = await createTestUser("scope-A");
  const ownerB = await createTestUser("scope-B");
  await seedKey(ownerA.workspaceId, KEY_READ, ownerA.userId, ["read"]);
  await seedKey(ownerA.workspaceId, KEY_WRITE, ownerA.userId, ["read", "write"]);
  await seedKey(ownerA.workspaceId, KEY_SEND, ownerA.userId, ["send"]);
  await seedKey(ownerA.workspaceId, KEY_FULL, ownerA.userId); // legacy → DB default = full
  await seedKey(ownerB.workspaceId, KEY_B, ownerB.userId); // full key in B
  A = { workspaceId: ownerA.workspaceId, userId: ownerA.userId, ...(await seedWorkspace(ownerA.workspaceId)) };
  B = { workspaceId: ownerB.workspaceId, ...(await seedWorkspace(ownerB.workspaceId)) };
});

beforeEach(() => {
  state.session = null;
  _resetRateLimits();
});

describe("scopes — read-only key (['read'])", () => {
  it("reads (flows GET) → 200", async () => {
    expect((await flowsGET(get(KEY_READ))).status).toBe(200);
  });
  it("writes (flows POST) → 403 Insufficient scope", async () => {
    const res = await flowsPOST(post(KEY_READ, { name: "nope" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Insufficient scope");
  });
  it("sends (messages POST) → 403", async () => {
    const res = await messagesPOST(post(KEY_READ, { conversationId: A.conversationId, text: "hi" }));
    expect(res.status).toBe(403);
  });
  it("sends (broadcasts/send) → 403", async () => {
    const res = await broadcastSend(post(KEY_READ, {}), { params: Promise.resolve({ broadcastId: A.broadcastId }) });
    expect(res.status).toBe(403);
  });
});

describe("scopes — write key (['read','write'])", () => {
  it("reads → 200, writes → 201", async () => {
    expect((await flowsGET(get(KEY_WRITE))).status).toBe(200);
    expect((await flowsPOST(post(KEY_WRITE, { name: "by writer" }))).status).toBe(201);
  });
  it("sends (messages POST) → 403 (write does not grant send)", async () => {
    expect((await messagesPOST(post(KEY_WRITE, { conversationId: A.conversationId, text: "hi" }))).status).toBe(403);
  });
  it("sends (broadcasts/send) → 403", async () => {
    const res = await broadcastSend(post(KEY_WRITE, {}), { params: Promise.resolve({ broadcastId: A.broadcastId }) });
    expect(res.status).toBe(403);
  });
});

describe("scopes — send-only key (['send'])", () => {
  it("reads (flows GET) → 403 (send does not grant read)", async () => {
    expect((await flowsGET(get(KEY_SEND))).status).toBe(403);
  });
  it("writes (flows POST) → 403 (send does not grant write)", async () => {
    expect((await flowsPOST(post(KEY_SEND, { name: "nope" }))).status).toBe(403);
  });
  it("sends (messages POST) passes scope → 400 (own conv, no Zernio key), not 403/401", async () => {
    const res = await messagesPOST(post(KEY_SEND, { conversationId: A.conversationId, text: "hi" }));
    expect(res.status).toBe(400);
  });
  it("sends (broadcasts/send) passes scope → 400 (own broadcast, no content), not 403/401", async () => {
    const res = await broadcastSend(post(KEY_SEND, {}), { params: Promise.resolve({ broadcastId: A.broadcastId }) });
    expect(res.status).toBe(400);
  });
});

describe("scopes — legacy/full key (no scopes column → DB default full)", () => {
  it("reads → 200, writes → 201 (backward-compatible)", async () => {
    expect((await flowsGET(get(KEY_FULL))).status).toBe(200);
    expect((await flowsPOST(post(KEY_FULL, { name: "by full" }))).status).toBe(201);
  });
  it("sends (messages POST) passes scope → 400, not 403", async () => {
    expect((await messagesPOST(post(KEY_FULL, { conversationId: A.conversationId, text: "hi" }))).status).toBe(400);
  });
  it("sends (broadcasts/send) passes scope → 400, not 403", async () => {
    const res = await broadcastSend(post(KEY_FULL, {}), { params: Promise.resolve({ broadcastId: A.broadcastId }) });
    expect(res.status).toBe(400);
  });
});

describe("scopes — session auth bypasses scope checks (full access)", () => {
  it("a logged-in session writes flows with no scope gate", async () => {
    const owner = await createTestUser("scope-session");
    state.session = owner.client;
    const res = await flowsPOST(new NextRequest(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "by session" }),
    }));
    expect(res.status).toBe(201);
  });
});

describe("scopes — cross-tenant isolation still holds (a full key can't cross workspaces)", () => {
  it("A's full key never sees B's flow and 404s on it", async () => {
    const ids = (await (await flowsGET(get(KEY_FULL))).json()).map((f: { id: string }) => f.id);
    expect(ids).not.toContain(B.flowId);
    expect((await flowGET(get(KEY_FULL), { params: Promise.resolve({ flowId: B.flowId }) })).status).toBe(404);
  });
  it("B's full key passes its own scope but is tenant-isolated from A", async () => {
    expect((await flowGET(get(KEY_B), { params: Promise.resolve({ flowId: A.flowId }) })).status).toBe(404);
  });
});

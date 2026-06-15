import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { anonClient, serviceClient, createTestUser } from "./helpers";

// Session path → the (mock-settable) session client; API-key path → real service client.
const state = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.session ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

// Converted routes (API-key parity)
import { GET as flowsGET, POST as flowsPOST } from "@/app/api/v1/flows/route";
import { GET as flowGET, PUT as flowPUT, DELETE as flowDELETE } from "@/app/api/v1/flows/[flowId]/route";
import { POST as flowPublish } from "@/app/api/v1/flows/[flowId]/publish/route";
import { GET as flowVersions } from "@/app/api/v1/flows/[flowId]/versions/route";
import { POST as flowRestore } from "@/app/api/v1/flows/[flowId]/versions/[versionId]/restore/route";
import { GET as contactsGET } from "@/app/api/v1/contacts/route";
import { GET as broadcastsGET, POST as broadcastsPOST } from "@/app/api/v1/broadcasts/route";
import { GET as messagesGET, POST as messagesPOST } from "@/app/api/v1/messages/route";
// Held session-only by design
import { POST as broadcastSend } from "@/app/api/v1/broadcasts/[broadcastId]/send/route";
import { _resetRateLimits } from "@/lib/rate-limit";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function seedKey(workspaceId: string, raw: string, createdBy: string) {
  const { error } = await serviceClient().from("api_keys").insert({
    workspace_id: workspaceId,
    name: "parity test key",
    key_hash: sha256(raw),
    key_prefix: raw.slice(0, 12) + "...",
    created_by: createdBy,
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
const put = (raw: string, body: unknown) =>
  new NextRequest(URL, {
    method: "PUT",
    headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Seed a full data set (flow + version + contact + broadcast + conversation) into a workspace. */
async function seedWorkspace(workspaceId: string) {
  const svc = serviceClient();
  const { data: flow } = await svc
    .from("flows")
    .insert({ workspace_id: workspaceId, name: "wsflow", status: "draft", version: 1, nodes: [{ id: "n1" }], edges: [] })
    .select("id, status")
    .single();
  const { data: version } = await svc
    .from("flow_versions")
    .insert({ flow_id: flow!.id, version: 1, name: "v1", nodes: [{ id: "old" }], edges: [] })
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
  return {
    flowId: flow!.id,
    versionId: version!.id,
    contactId: contact!.id,
    broadcastId: broadcast!.id,
    conversationId: conversation!.id,
  };
}

const KEY_A = "zf_parityA00000000000000000000aa";
let A: { workspaceId: string; userId: string } & Awaited<ReturnType<typeof seedWorkspace>>;
let B: Awaited<ReturnType<typeof seedWorkspace>> & { workspaceId: string };
let ownerAClient: unknown;

beforeAll(async () => {
  const ownerA = await createTestUser("parity-A");
  const ownerB = await createTestUser("parity-B");
  ownerAClient = ownerA.client;
  await seedKey(ownerA.workspaceId, KEY_A, ownerA.userId);
  A = { workspaceId: ownerA.workspaceId, userId: ownerA.userId, ...(await seedWorkspace(ownerA.workspaceId)) };
  B = { workspaceId: ownerB.workspaceId, ...(await seedWorkspace(ownerB.workspaceId)) };
});

beforeEach(() => {
  state.session = null;
  _resetRateLimits();
});

describe("API-key parity — a key reads/writes ITS OWN workspace", () => {
  it("flows list returns the caller's flow", async () => {
    const res = await flowsGET(get(KEY_A));
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((f: { id: string }) => f.id);
    expect(ids).toContain(A.flowId);
  });

  it("flows create writes into the caller's workspace", async () => {
    const res = await flowsPOST(post(KEY_A, { name: "made by key" }));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const { data } = await serviceClient().from("flows").select("workspace_id").eq("id", id).single();
    expect(data!.workspace_id).toBe(A.workspaceId);
  });

  it("flow get / versions list resolve the caller's flow", async () => {
    expect((await flowGET(get(KEY_A), { params: Promise.resolve({ flowId: A.flowId }) })).status).toBe(200);
    const vres = await flowVersions(get(KEY_A), { params: Promise.resolve({ flowId: A.flowId }) });
    expect(vres.status).toBe(200);
    expect((await vres.json()).length).toBeGreaterThanOrEqual(1);
  });

  it("flow publish snapshots with a NULL published_by (no user identity for keys)", async () => {
    const res = await flowPublish(post(KEY_A, {}), { params: Promise.resolve({ flowId: A.flowId }) });
    expect(res.status).toBe(200);
    const { data: snap } = await serviceClient()
      .from("flow_versions")
      .select("published_by")
      .eq("flow_id", A.flowId)
      .order("version", { ascending: false })
      .limit(1)
      .single();
    expect(snap!.published_by).toBeNull();
  });

  it("contacts / broadcasts lists return the caller's rows", async () => {
    const c = (await (await contactsGET(get(KEY_A))).json()).contacts.map((x: { id: string }) => x.id);
    expect(c).toContain(A.contactId);
    const b = (await (await broadcastsGET(get(KEY_A))).json()).map((x: { id: string }) => x.id);
    expect(b).toContain(A.broadcastId);
  });

  it("broadcasts create writes into the caller's workspace", async () => {
    const res = await broadcastsPOST(post(KEY_A, { name: "key broadcast" }));
    expect(res.status).toBe(201);
    expect((await res.json()).workspace_id).toBe(A.workspaceId);
  });

  it("messages reaches the caller's conversation (auth+scope pass → 400 missing Zernio key, not 401/404)", async () => {
    const res = await messagesGET(get(KEY_A, `?conversationId=${A.conversationId}`));
    expect(res.status).toBe(400); // found in A's workspace, then no Zernio key configured
  });
});

describe("API-key parity — cross-tenant isolation (A's key CANNOT touch B)", () => {
  it("flows list never includes B's flow", async () => {
    const ids = (await (await flowsGET(get(KEY_A))).json()).map((f: { id: string }) => f.id);
    expect(ids).not.toContain(B.flowId);
  });

  it("flow GET on B's flow → 404", async () => {
    expect((await flowGET(get(KEY_A), { params: Promise.resolve({ flowId: B.flowId }) })).status).toBe(404);
  });

  it("flow PUT on B's flow → 404 and B's flow is unchanged", async () => {
    const res = await flowPUT(put(KEY_A, { name: "hacked" }), { params: Promise.resolve({ flowId: B.flowId }) });
    expect(res.status).toBe(404);
    const { data } = await serviceClient().from("flows").select("name").eq("id", B.flowId).single();
    expect(data!.name).toBe("wsflow");
  });

  it("flow DELETE on B's flow → B's flow still exists", async () => {
    await flowDELETE(get(KEY_A), { params: Promise.resolve({ flowId: B.flowId }) });
    const { data } = await serviceClient().from("flows").select("id").eq("id", B.flowId).maybeSingle();
    expect(data).not.toBeNull();
  });

  it("flow publish on B's flow → 404 and B's flow status unchanged", async () => {
    const res = await flowPublish(post(KEY_A, {}), { params: Promise.resolve({ flowId: B.flowId }) });
    expect(res.status).toBe(404);
    const { data } = await serviceClient().from("flows").select("status").eq("id", B.flowId).single();
    expect(data!.status).toBe("draft");
  });

  it("flow versions list on B's flow → 404 (no flow_versions leak)", async () => {
    expect((await flowVersions(get(KEY_A), { params: Promise.resolve({ flowId: B.flowId }) })).status).toBe(404);
  });

  it("flow restore: B's flow → 404; B's version into A's flow → 404", async () => {
    const xTenantFlow = await flowRestore(get(KEY_A), {
      params: Promise.resolve({ flowId: B.flowId, versionId: B.versionId }),
    });
    expect(xTenantFlow.status).toBe(404);
    const xTenantVersion = await flowRestore(get(KEY_A), {
      params: Promise.resolve({ flowId: A.flowId, versionId: B.versionId }),
    });
    expect(xTenantVersion.status).toBe(404);
  });

  it("contacts / broadcasts lists never include B's rows", async () => {
    const c = (await (await contactsGET(get(KEY_A))).json()).contacts.map((x: { id: string }) => x.id);
    expect(c).not.toContain(B.contactId);
    const b = (await (await broadcastsGET(get(KEY_A))).json()).map((x: { id: string }) => x.id);
    expect(b).not.toContain(B.broadcastId);
  });

  it("messages GET/POST on B's conversation → 404", async () => {
    expect((await messagesGET(get(KEY_A, `?conversationId=${B.conversationId}`))).status).toBe(404);
    const send = await messagesPOST(post(KEY_A, { conversationId: B.conversationId, text: "hi" }));
    expect(send.status).toBe(404);
  });
});

describe("API-key parity — own-workspace WRITES succeed (make the cross-tenant 404s meaningful)", () => {
  // Without these, a route that 404'd for EVERYONE (owner included) would still
  // pass the cross-tenant assertions. These prove the 404 is specifically the
  // tenant boundary, not a broken route. Throwaway resources, so shared A/B
  // fixtures other tests assert on are untouched.
  it("flow PUT updates the caller's own flow", async () => {
    const { data: f } = await serviceClient()
      .from("flows")
      .insert({ workspace_id: A.workspaceId, name: "before", status: "draft", version: 1, nodes: [], edges: [] })
      .select("id")
      .single();
    const res = await flowPUT(put(KEY_A, { name: "after" }), { params: Promise.resolve({ flowId: f!.id }) });
    expect(res.status).toBe(200);
    const { data } = await serviceClient().from("flows").select("name").eq("id", f!.id).single();
    expect(data!.name).toBe("after");
  });

  it("flow DELETE removes the caller's own flow", async () => {
    const { data: f } = await serviceClient()
      .from("flows")
      .insert({ workspace_id: A.workspaceId, name: "doomed", status: "draft", version: 1, nodes: [], edges: [] })
      .select("id")
      .single();
    const res = await flowDELETE(get(KEY_A), { params: Promise.resolve({ flowId: f!.id }) });
    expect(res.status).toBe(200);
    const { data } = await serviceClient().from("flows").select("id").eq("id", f!.id).maybeSingle();
    expect(data).toBeNull();
  });

  it("flow restore copies the caller's own version back into the caller's flow", async () => {
    const svc = serviceClient();
    const { data: f } = await svc
      .from("flows")
      .insert({ workspace_id: A.workspaceId, name: "restorable", status: "published", version: 2, nodes: [{ id: "current" }], edges: [] })
      .select("id")
      .single();
    const { data: v } = await svc
      .from("flow_versions")
      .insert({ flow_id: f!.id, version: 1, name: "snap", nodes: [{ id: "restored" }], edges: [] })
      .select("id")
      .single();
    const res = await flowRestore(get(KEY_A), { params: Promise.resolve({ flowId: f!.id, versionId: v!.id }) });
    expect(res.status).toBe(200);
    const { data } = await svc.from("flows").select("nodes, status").eq("id", f!.id).single();
    expect(data!.nodes).toEqual([{ id: "restored" }]);
    expect(data!.status).toBe("draft");
  });

  it("messages POST reaches the caller's own conversation (auth+scope pass → 400 missing Zernio key, not 401/404)", async () => {
    const res = await messagesPOST(post(KEY_A, { conversationId: A.conversationId, text: "hi" }));
    expect(res.status).toBe(400);
  });
});

describe("broadcasts/send — hold lifted, now behind the send scope", () => {
  // KEY_A is a full key (no scopes column → DB default read,write,send), so it
  // holds send. It passes auth + scope and reaches the broadcast (a draft with
  // empty content) → 400 missing content, NOT 401. Per-scope behaviour
  // (read/write keys 403'd here) is covered in v1-scopes.test.ts.
  it("a full API key (holds send) passes auth+scope → 400 missing content, not 401", async () => {
    const res = await broadcastSend(post(KEY_A, {}), { params: Promise.resolve({ broadcastId: A.broadcastId }) });
    expect(res.status).toBe(400);
  });

  it("still works for a session caller (passes auth → 400 missing content, not 401)", async () => {
    state.session = ownerAClient;
    const res = await broadcastSend(
      new NextRequest(URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      { params: Promise.resolve({ broadcastId: A.broadcastId }) }
    );
    expect(res.status).not.toBe(401);
  });
});

describe("converted routes still serve session auth", () => {
  it("flows list works for a logged-in session (no Bearer)", async () => {
    state.session = ownerAClient;
    const res = await flowsGET(new NextRequest(URL));
    expect(res.status).toBe(200);
  });
});

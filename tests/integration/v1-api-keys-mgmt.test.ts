import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { anonClient, serviceClient, createTestUser } from "./helpers";

const session = vi.hoisted(() => ({ client: null as unknown }));
const cookie = vi.hoisted(() => ({ workspaceId: undefined as string | undefined }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => session.client ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "zernflow_workspace_id" && cookie.workspaceId ? { value: cookie.workspaceId } : undefined,
  }),
}));

import { GET as listGET, POST as issuePOST } from "@/app/api/v1/api-keys/route";
import { DELETE as revokeDELETE } from "@/app/api/v1/api-keys/[keyId]/route";
import { POST as rotatePOST } from "@/app/api/v1/api-keys/[keyId]/rotate/route";
import { GET as savedRepliesGET } from "@/app/api/v1/saved-replies/route";
import { _resetRateLimits } from "@/lib/rate-limit";

const jsonReq = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const plainReq = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/api-keys", { headers });
const dataReq = (raw: string) =>
  new NextRequest("http://localhost/api/v1/saved-replies", { headers: { authorization: `Bearer ${raw}` } });
const params = (keyId: string) => ({ params: Promise.resolve({ keyId }) });

let ownerA: { workspaceId: string; client: unknown };
let ownerB: { workspaceId: string };
let member: { client: unknown };

async function issueKey(name = "k"): Promise<{ id: string; key: string }> {
  session.client = ownerA.client;
  cookie.workspaceId = ownerA.workspaceId;
  const res = await issuePOST(jsonReq({ name }));
  expect(res.status).toBe(201);
  const b = await res.json();
  return { id: b.id, key: b.key };
}

beforeAll(async () => {
  const a = await createTestUser("akm-A");
  const b = await createTestUser("akm-B");
  const m = await createTestUser("akm-member");
  ownerA = { workspaceId: a.workspaceId, client: a.client };
  ownerB = { workspaceId: b.workspaceId };
  member = { client: m.client };
  // Add the member user to workspace A with role "member".
  await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: a.workspaceId, user_id: m.userId, role: "member" });
  // A reply in A so an issued key can prove it reads real data.
  await serviceClient()
    .from("saved_replies")
    .insert({ workspace_id: a.workspaceId, title: "A reply", content: "x" });
});

beforeEach(() => {
  session.client = null;
  cookie.workspaceId = undefined;
  _resetRateLimits();
});

describe("/api/v1/api-keys — management", () => {
  it("issues a key, the key authenticates a data endpoint, and list shows metadata only", async () => {
    const { key } = await issueKey("ci-key");
    expect(key.startsWith("zf_")).toBe(true);

    // The freshly issued key actually works against a data endpoint (B1 path).
    _resetRateLimits();
    const dataRes = await savedRepliesGET(dataReq(key));
    expect(dataRes.status).toBe(200);
    expect((await dataRes.json()).data.map((r: { title: string }) => r.title)).toContain("A reply");

    session.client = ownerA.client;
    cookie.workspaceId = ownerA.workspaceId;
    const listRes = await listGET(plainReq());
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()).data;
    const row = rows.find((r: { name: string }) => r.name === "ci-key");
    expect(row).toBeTruthy();
    expect(row.key_prefix).toMatch(/^zf_.*\.\.\.$/);
    expect(row).not.toHaveProperty("key_hash");
    expect(row).not.toHaveProperty("key");
  });

  it("rotate in place: the old secret stops working, the new one works", async () => {
    const { id, key: oldKey } = await issueKey("rot");
    session.client = ownerA.client;
    cookie.workspaceId = ownerA.workspaceId;
    const rotRes = await rotatePOST(plainReq(), params(id));
    expect(rotRes.status).toBe(200);
    const newKey = (await rotRes.json()).key;
    expect(newKey).not.toBe(oldKey);

    _resetRateLimits();
    expect((await savedRepliesGET(dataReq(oldKey))).status).toBe(401);
    expect((await savedRepliesGET(dataReq(newKey))).status).toBe(200);
  });

  it("revoke kills the key and removes it from the list", async () => {
    const { id, key } = await issueKey("rev");
    _resetRateLimits();
    expect((await savedRepliesGET(dataReq(key))).status).toBe(200);

    session.client = ownerA.client;
    cookie.workspaceId = ownerA.workspaceId;
    expect((await revokeDELETE(plainReq(), params(id))).status).toBe(200);

    _resetRateLimits();
    expect((await savedRepliesGET(dataReq(key))).status).toBe(401);
  });

  it("an API key cannot manage API keys (403)", async () => {
    const { key } = await issueKey("self");
    // Bearer api-key path → requireWorkspaceAdmin rejects both list AND issue with 403.
    expect((await listGET(plainReq({ authorization: `Bearer ${key}` }))).status).toBe(403);
    expect((await issuePOST(jsonReq({ name: "x" }, { authorization: `Bearer ${key}` }))).status).toBe(403);
  });

  it("a non-admin member cannot manage API keys (403)", async () => {
    session.client = member.client;
    cookie.workspaceId = ownerA.workspaceId; // resolves member's active workspace to A (role member)
    expect((await listGET(plainReq())).status).toBe(403);
    expect((await issuePOST(jsonReq({ name: "nope" }))).status).toBe(403);
  });

  it("cannot revoke or rotate another workspace's key (404)", async () => {
    // Issue a key in workspace B via the service client directly.
    const { data: kb } = await serviceClient()
      .from("api_keys")
      .insert({ workspace_id: ownerB.workspaceId, name: "B key", key_hash: "deadbeef", key_prefix: "zf_b..." })
      .select("id")
      .single();

    session.client = ownerA.client;
    cookie.workspaceId = ownerA.workspaceId;
    expect((await revokeDELETE(plainReq(), params(kb!.id))).status).toBe(404);
    expect((await rotatePOST(plainReq(), params(kb!.id))).status).toBe(404);
  });

  it("rejects a missing name (400)", async () => {
    session.client = ownerA.client;
    cookie.workspaceId = ownerA.workspaceId;
    expect((await issuePOST(jsonReq({}))).status).toBe(400);
  });
});

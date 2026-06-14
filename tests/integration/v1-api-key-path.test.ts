import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { anonClient, serviceClient, createTestUser } from "./helpers";

// Session path → the (mock-settable) session client; service path → real service client.
const state = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.session ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { GET as savedRepliesGET } from "@/app/api/v1/saved-replies/route";
import { GET as flowExportGET } from "@/app/api/v1/flows/[flowId]/export/route";
import { _resetRateLimits } from "@/lib/rate-limit";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function seedKey(workspaceId: string, raw: string, createdBy: string, expiresAt: string | null = null) {
  const { error } = await serviceClient().from("api_keys").insert({
    workspace_id: workspaceId,
    name: "test key",
    key_hash: sha256(raw),
    key_prefix: raw.slice(0, 12) + "...",
    created_by: createdBy,
    expires_at: expiresAt,
  });
  expect(error).toBeNull();
}

const bearer = (raw: string) =>
  new NextRequest("http://localhost/api/v1/saved-replies", { headers: { authorization: `Bearer ${raw}` } });

let A: { workspaceId: string; userId: string };
let B: { workspaceId: string; flowId: string };
const VALID = "zf_validkey000000000000000000aaaa";
const EXPIRED = "zf_expiredkey0000000000000000bbbb";

beforeAll(async () => {
  const ownerA = await createTestUser("apik-A");
  const ownerB = await createTestUser("apik-B");
  A = { workspaceId: ownerA.workspaceId, userId: ownerA.userId };

  await serviceClient().from("saved_replies").insert([
    { workspace_id: ownerA.workspaceId, title: "A reply", content: "from A" },
    { workspace_id: ownerB.workspaceId, title: "B reply", content: "from B" },
  ]);
  const { data: flowB } = await serviceClient()
    .from("flows")
    .insert({ workspace_id: ownerB.workspaceId, name: "B flow", status: "draft" })
    .select("id")
    .single();
  B = { workspaceId: ownerB.workspaceId, flowId: flowB!.id };

  await seedKey(A.workspaceId, VALID, ownerA.userId);
  await seedKey(A.workspaceId, EXPIRED, ownerA.userId, "2020-01-01T00:00:00.000Z");
});

beforeEach(() => {
  state.session = null;
  _resetRateLimits();
});

describe("/api/v1 — API-key data path", () => {
  it("a valid API key reads ITS OWN workspace data (the data-path fix)", async () => {
    const res = await savedRepliesGET(bearer(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = (body.data ?? []).map((r: { title: string }) => r.title);
    expect(titles).toContain("A reply");
  });

  it("a valid API key CANNOT see another workspace's data (tenant isolation)", async () => {
    const res = await savedRepliesGET(bearer(VALID));
    const body = await res.json();
    const titles = (body.data ?? []).map((r: { title: string }) => r.title);
    expect(titles).not.toContain("B reply");
  });

  it("an API key cannot reach another workspace's resource via an ownership-chain route (404)", async () => {
    const res = await flowExportGET(bearer(VALID), { params: Promise.resolve({ flowId: B.flowId }) });
    expect(res.status).toBe(404); // service client bypasses RLS, but the .eq(workspace_id) gate still 404s
  });

  it("an expired API key is rejected (401)", async () => {
    const res = await savedRepliesGET(bearer(EXPIRED));
    expect(res.status).toBe(401);
  });

  it("an unknown/invalid API key is rejected (401)", async () => {
    const res = await savedRepliesGET(bearer("zf_doesnotexist000000000000000000"));
    expect(res.status).toBe(401);
  });

  it("rate-limits API-key traffic (429 past the per-workspace budget)", async () => {
    let last = 200;
    for (let i = 0; i < 121; i++) {
      last = (await savedRepliesGET(bearer(VALID))).status;
    }
    expect(last).toBe(429);
  });

  it("session auth still works (no Bearer → session client path)", async () => {
    const owner = await createTestUser("apik-session");
    await serviceClient()
      .from("saved_replies")
      .insert({ workspace_id: owner.workspaceId, title: "session reply", content: "x" });
    state.session = owner.client;

    const res = await savedRepliesGET(
      new NextRequest("http://localhost/api/v1/saved-replies")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body.data ?? []).map((r: { title: string }) => r.title)).toContain("session reply");
  });
});

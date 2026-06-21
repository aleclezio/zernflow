import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { serviceClient, createTestUser } from "./helpers";

// Engine uses the service client + the Zernio SDK; replace both seams only.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => serviceClient(),
  createServiceClient: async () => serviceClient(),
}));

const listProfiles = vi.fn();
const listAccounts = vi.fn();
const createWebhookSettings = vi.fn();
const deleteWebhookSettings = vi.fn();
vi.mock("@/lib/zernio-client", () => ({
  createZernioClient: () => ({
    profiles: { listProfiles },
    accounts: { listAccounts },
    webhooks: { createWebhookSettings, deleteWebhookSettings },
  }),
}));

import { POST } from "@/app/api/admin/onboard-client/route";

const TOKEN = "admin-token-" + crypto.randomUUID();
const ORIGINAL = process.env.ONBOARD_ADMIN_TOKEN;

let testProfileId = "";
let testAccountId = "";

beforeEach(() => {
  process.env.ONBOARD_ADMIN_TOKEN = TOKEN;
  testProfileId = `prof-${crypto.randomUUID()}`;
  testAccountId = `acc-${crypto.randomUUID()}`;

  listProfiles.mockReset();
  listProfiles.mockResolvedValue({ data: { profiles: [{ _id: testProfileId, name: "Default" }] } });
  listAccounts.mockReset();
  listAccounts.mockResolvedValue({
    data: { accounts: [{ _id: testAccountId, platform: "instagram", username: "c_ig", profileId: testProfileId }] },
  });
  createWebhookSettings.mockReset();
  createWebhookSettings.mockResolvedValue({ data: { webhook: { _id: `wh-${crypto.randomUUID()}` } } });
  deleteWebhookSettings.mockReset();
  deleteWebhookSettings.mockResolvedValue({ data: { success: true } });
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.ONBOARD_ADMIN_TOKEN;
  else process.env.ONBOARD_ADMIN_TOKEN = ORIGINAL;
});

function makeRequest(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/admin/onboard-client", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/onboard-client", () => {
  it("rejects requests without the admin token (401), running the engine zero times", async () => {
    const res = await POST(makeRequest({ name: "X", ownerUserId: "x", zernioApiKey: "k" }));
    expect(res.status).toBe(401);
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it("rejects a wrong admin token (401)", async () => {
    const res = await POST(makeRequest({ name: "X", ownerUserId: "x", zernioApiKey: "k" }, "wrong"));
    expect(res.status).toBe(401);
  });

  it("requires name, ownerUserId, and zernioApiKey (400)", async () => {
    const res = await POST(makeRequest({ name: "X" }, TOKEN));
    expect(res.status).toBe(400);
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it("provisions a tenant and returns the scoped key once", async () => {
    const owner = await createTestUser("route-ob");
    const name = `RouteClient ${crypto.randomUUID()}`;

    const res = await POST(
      makeRequest(
        { name, ownerUserId: owner.userId, zernioApiKey: "zern-key", appUrl: "https://os.test/engage" },
        TOKEN
      )
    );
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.workspaceCreated).toBe(true);
    expect(out.apiKey.issued).toBe(true);
    expect(out.apiKey.key).toMatch(/^zf_/);

    const { data: ws } = await serviceClient()
      .from("workspaces")
      .select("zernio_profile_id")
      .eq("id", out.workspaceId)
      .single();
    expect(ws?.zernio_profile_id).toBe(testProfileId);
  });

  it("maps a multi-profile bind ambiguity to 422 (PROFILE_CHOICE_REQUIRED)", async () => {
    const owner = await createTestUser("route-multi");
    listProfiles.mockResolvedValue({
      data: { profiles: [{ _id: testProfileId, name: "A" }, { _id: `prof-${crypto.randomUUID()}`, name: "B" }] },
    });

    const res = await POST(
      makeRequest({ name: `Multi ${crypto.randomUUID()}`, ownerUserId: owner.userId, zernioApiKey: "k" }, TOKEN)
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("PROFILE_CHOICE_REQUIRED");
  });
});

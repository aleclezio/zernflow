import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { anonClient, serviceClient, createTestUser } from "./helpers";
import { _resetRateLimits } from "@/lib/rate-limit";
import { isEncrypted } from "@/lib/crypto";

// Seam: replace cookie plumbing only — RLS and the DB stay real.
let currentClient: SupabaseClient<Database> | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));

// No real Zernio traffic in integration tests.
const listAccounts = vi.fn();
const listProfiles = vi.fn();
vi.mock("@/lib/zernio-client", () => ({
  createZernioClient: () => ({
    accounts: { listAccounts },
    profiles: { listProfiles },
  }),
}));

import { POST } from "@/app/api/v1/channels/test-key/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/channels/test-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Per-test unique ids: profile<->workspace binding and active accounts are
// globally unique (00011), so fixtures must not collide across tests.
let testProfileId = "";
let testAccountId = "";

beforeEach(() => {
  currentClient = null;
  _resetRateLimits();
  testProfileId = `prof-${crypto.randomUUID()}`;
  testAccountId = `acc-${crypto.randomUUID()}`;
  listProfiles.mockReset();
  listProfiles.mockResolvedValue({
    data: { profiles: [{ _id: testProfileId, name: "Default" }] },
  });
  listAccounts.mockReset();
  listAccounts.mockResolvedValue({
    data: {
      accounts: [
        {
          _id: testAccountId,
          platform: "instagram",
          username: "test_ig",
          displayName: "Test IG",
          profileId: testProfileId,
        },
      ],
    },
  });
});

describe("POST /api/v1/channels/test-key", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const owner = await createTestUser("tk-anon");
    currentClient = null; // anonymous

    const res = await POST(makeRequest({ apiKey: "k-anon-probe", workspaceId: owner.workspaceId }));

    expect(res.status).toBe(401);
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it("rejects non-owner members with 403", async () => {
    const owner = await createTestUser("tk-owner");
    const member = await createTestUser("tk-member");

    const { error } = await owner.client.from("workspace_members").insert({
      workspace_id: owner.workspaceId,
      user_id: member.userId,
      role: "member",
    });
    expect(error).toBeNull();

    currentClient = member.client;
    const res = await POST(makeRequest({ apiKey: "k-member-probe", workspaceId: owner.workspaceId }));

    expect(res.status).toBe(403);
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it("rejects requests for workspaces the user does not belong to with 403", async () => {
    const alice = await createTestUser("tk-alice");
    const mallory = await createTestUser("tk-mallory");

    currentClient = mallory.client;
    const res = await POST(makeRequest({ apiKey: "k-mallory", workspaceId: alice.workspaceId }));

    expect(res.status).toBe(403);
  });

  it("requires workspaceId (key validation without saving is not exposed)", async () => {
    const owner = await createTestUser("tk-nows");
    currentClient = owner.client;

    const res = await POST(makeRequest({ apiKey: "k-no-ws" }));

    expect(res.status).toBe(400);
  });

  it("stores the key encrypted (enc:v1), never plaintext, and syncs channels", async () => {
    const owner = await createTestUser("tk-save");
    currentClient = owner.client;

    const res = await POST(makeRequest({ apiKey: "zern-live-key-xyz", workspaceId: owner.workspaceId }));
    expect(res.status).toBe(200);

    const { data: ws } = await serviceClient()
      .from("workspaces")
      .select("late_api_key_encrypted")
      .eq("id", owner.workspaceId)
      .single();

    expect(ws?.late_api_key_encrypted).toBeTruthy();
    expect(ws?.late_api_key_encrypted).not.toContain("zern-live-key-xyz");
    expect(isEncrypted(ws?.late_api_key_encrypted)).toBe(true);

    const { data: channels } = await serviceClient()
      .from("channels")
      .select("late_account_id, workspace_id")
      .eq("workspace_id", owner.workspaceId);
    expect(channels).toHaveLength(1);
    expect(channels?.[0].late_account_id).toBe(testAccountId);
  });

  it("returns a generic 400 on SDK failure without echoing SDK error detail", async () => {
    const owner = await createTestUser("tk-sdkerr");
    currentClient = owner.client;
    listAccounts.mockRejectedValue(
      new Error("Request failed: Authorization header invalid for key zern-secret-echo")
    );

    const res = await POST(makeRequest({ apiKey: "k-bad", workspaceId: owner.workspaceId }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("zern-secret-echo");
  });

  it("rate limits after 5 attempts per minute with 429", async () => {
    const owner = await createTestUser("tk-rate");
    currentClient = owner.client;

    for (let i = 0; i < 5; i++) {
      const res = await POST(makeRequest({ apiKey: `k-${i}`, workspaceId: owner.workspaceId }));
      expect(res.status).toBe(200);
    }
    const res = await POST(makeRequest({ apiKey: "k-6", workspaceId: owner.workspaceId }));
    expect(res.status).toBe(429);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { anonClient, serviceClient, createTestUser } from "./helpers";
import { _resetRateLimits } from "@/lib/rate-limit";

let currentClient: SupabaseClient<Database> | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));

// The three channels routes now go through authorizeApiV1, which reads the
// workspace-switcher cookies via next/headers. Mutable so a test can switch.
let currentCookies: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      currentCookies[name] ? { name, value: currentCookies[name] } : undefined,
  }),
}));

const listAccounts = vi.fn();
const listProfiles = vi.fn();
const getConnectUrl = vi.fn();
vi.mock("@/lib/zernio-client", () => ({
  createZernioClient: () => ({
    accounts: { listAccounts },
    profiles: { listProfiles },
    connect: { getConnectUrl },
  }),
}));

import { POST as testKeyPOST } from "@/app/api/v1/channels/test-key/route";
import { POST as syncPOST } from "@/app/api/v1/channels/sync/route";
import { POST as connectPOST } from "@/app/api/v1/channels/connect/route";
import { GET as channelsGET } from "@/app/api/v1/channels/route";

function testKeyReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/channels/test-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function channelsReq(): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/channels");
}

function syncReq(): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/channels/sync", {
    method: "POST",
  });
}

function connectReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/channels/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let profileSeq = 0;
function uniqueProfileId(label: string) {
  return `prof-${Date.now()}-${profileSeq++}-${label}`;
}

async function bindProfile(workspaceId: string, profileId: string) {
  const { error } = await serviceClient()
    .from("workspaces")
    .update({ zernio_profile_id: profileId, zernio_profile_name: "Test Profile" })
    .eq("id", workspaceId);
  expect(error).toBeNull();
}

beforeEach(() => {
  currentClient = null;
  currentCookies = {};
  _resetRateLimits();
  listAccounts.mockReset();
  listProfiles.mockReset();
  getConnectUrl.mockReset();
});

describe("profile binding schema (00011)", () => {
  it("rejects binding the same Zernio profile to two workspaces", async () => {
    const a = await createTestUser("ps-bind-a");
    const b = await createTestUser("ps-bind-b");
    const profileId = uniqueProfileId("dup");

    await bindProfile(a.workspaceId, profileId);

    const { error } = await serviceClient()
      .from("workspaces")
      .update({ zernio_profile_id: profileId })
      .eq("id", b.workspaceId);

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");
  });

  it("rejects the same Zernio account being ACTIVE in two workspaces", async () => {
    const a = await createTestUser("ps-acc-a");
    const b = await createTestUser("ps-acc-b");
    const accountId = `acc-${Date.now()}-dup`;

    const insertA = await serviceClient().from("channels").insert({
      workspace_id: a.workspaceId,
      platform: "instagram",
      late_account_id: accountId,
      is_active: true,
    });
    expect(insertA.error).toBeNull();

    const insertB = await serviceClient().from("channels").insert({
      workspace_id: b.workspaceId,
      platform: "instagram",
      late_account_id: accountId,
      is_active: true,
    });
    expect(insertB.error).not.toBeNull();
    expect(insertB.error?.code).toBe("23505");
  });
});

describe("fail-closed routes when profile is unbound (412 PROFILE_UNBOUND)", () => {
  it("sync returns 412 for an unbound workspace", async () => {
    const owner = await createTestUser("ps-sync-unbound");
    currentClient = owner.client;
    // configure a key so the 412 is specifically about the binding
    await serviceClient()
      .from("workspaces")
      .update({ late_api_key_encrypted: encryptedKeyFor(owner.workspaceId) })
      .eq("id", owner.workspaceId);

    const res = await syncPOST(syncReq());

    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.code).toBe("PROFILE_UNBOUND");
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it("connect returns 412 for an unbound workspace (no profiles[0] fallback)", async () => {
    const owner = await createTestUser("ps-conn-unbound");
    currentClient = owner.client;
    await serviceClient()
      .from("workspaces")
      .update({ late_api_key_encrypted: encryptedKeyFor(owner.workspaceId) })
      .eq("id", owner.workspaceId);

    listProfiles.mockResolvedValue({
      data: { profiles: [{ _id: "someone-elses-profile", name: "P" }] },
    });

    const res = await connectPOST(connectReq({ platform: "instagram" }));

    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.code).toBe("PROFILE_UNBOUND");
  });

  it("connect uses the BOUND profile id, never profiles[0]", async () => {
    const owner = await createTestUser("ps-conn-bound");
    const bound = uniqueProfileId("bound");
    await bindProfile(owner.workspaceId, bound);
    await serviceClient()
      .from("workspaces")
      .update({ late_api_key_encrypted: encryptedKeyFor(owner.workspaceId) })
      .eq("id", owner.workspaceId);
    currentClient = owner.client;

    getConnectUrl.mockResolvedValue({ data: { authUrl: "https://zernio.example/connect" } });

    const res = await connectPOST(connectReq({ platform: "instagram" }));

    expect(res.status).toBe(200);
    expect(getConnectUrl).toHaveBeenCalledTimes(1);
    const arg = getConnectUrl.mock.calls[0][0];
    expect(arg.query.profileId).toBe(bound);
  });
});

describe("test-key profile binding (never guess)", () => {
  it("auto-binds when the key sees exactly one profile", async () => {
    const owner = await createTestUser("ps-tk-single");
    currentClient = owner.client;
    const profileId = uniqueProfileId("single");

    listProfiles.mockResolvedValue({
      data: { profiles: [{ _id: profileId, name: "Client A" }] },
    });
    listAccounts.mockResolvedValue({
      data: {
        accounts: [
          { _id: `acc-${profileId}-1`, platform: "instagram", username: "a", profileId },
        ],
      },
    });

    const res = await testKeyPOST(
      testKeyReq({ apiKey: "k-single", workspaceId: owner.workspaceId })
    );
    expect(res.status).toBe(200);

    const { data: ws } = await serviceClient()
      .from("workspaces")
      .select("zernio_profile_id, zernio_profile_name")
      .eq("id", owner.workspaceId)
      .single();
    expect(ws?.zernio_profile_id).toBe(profileId);
    expect(ws?.zernio_profile_name).toBe("Client A");

    // account listing must be profile-filtered
    expect(listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ profileId }) })
    );
  });

  it("returns the profile list (422) when the key sees several profiles and none was chosen — key NOT saved", async () => {
    const owner = await createTestUser("ps-tk-multi");
    currentClient = owner.client;
    const p1 = uniqueProfileId("m1");
    const p2 = uniqueProfileId("m2");

    listProfiles.mockResolvedValue({
      data: { profiles: [{ _id: p1, name: "One" }, { _id: p2, name: "Two" }] },
    });

    const res = await testKeyPOST(
      testKeyReq({ apiKey: "k-multi", workspaceId: owner.workspaceId })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("PROFILE_CHOICE_REQUIRED");
    expect(body.profiles).toHaveLength(2);

    const { data: ws } = await serviceClient()
      .from("workspaces")
      .select("zernio_profile_id, late_api_key_encrypted")
      .eq("id", owner.workspaceId)
      .single();
    expect(ws?.zernio_profile_id).toBeNull();
    expect(ws?.late_api_key_encrypted).toBeNull();
  });

  it("binds the explicitly chosen profile on retry", async () => {
    const owner = await createTestUser("ps-tk-choice");
    currentClient = owner.client;
    const p1 = uniqueProfileId("c1");
    const p2 = uniqueProfileId("c2");

    listProfiles.mockResolvedValue({
      data: { profiles: [{ _id: p1, name: "One" }, { _id: p2, name: "Two" }] },
    });
    listAccounts.mockResolvedValue({ data: { accounts: [] } });

    const res = await testKeyPOST(
      testKeyReq({ apiKey: "k-choice", workspaceId: owner.workspaceId, profileId: p2 })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toBeTruthy(); // multi-profile key -> loud warning

    const { data: ws } = await serviceClient()
      .from("workspaces")
      .select("zernio_profile_id")
      .eq("id", owner.workspaceId)
      .single();
    expect(ws?.zernio_profile_id).toBe(p2);
  });

  it("rejects a key that cannot see the already-bound profile (409) — key NOT overwritten", async () => {
    const owner = await createTestUser("ps-tk-mismatch");
    currentClient = owner.client;
    const bound = uniqueProfileId("bound");
    await bindProfile(owner.workspaceId, bound);

    listProfiles.mockResolvedValue({
      data: { profiles: [{ _id: uniqueProfileId("other"), name: "Other" }] },
    });

    const res = await testKeyPOST(
      testKeyReq({ apiKey: "k-mismatch", workspaceId: owner.workspaceId })
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PROFILE_MISMATCH");

    const { data: ws } = await serviceClient()
      .from("workspaces")
      .select("late_api_key_encrypted")
      .eq("id", owner.workspaceId)
      .single();
    expect(ws?.late_api_key_encrypted).toBeNull();
  });
});

describe("scoped sync", () => {
  it("only syncs accounts of the bound profile; foreign accounts are dropped defensively", async () => {
    const owner = await createTestUser("ps-sync-scope");
    const bound = uniqueProfileId("sync");
    await bindProfile(owner.workspaceId, bound);
    await serviceClient()
      .from("workspaces")
      .update({ late_api_key_encrypted: encryptedKeyFor(owner.workspaceId) })
      .eq("id", owner.workspaceId);
    currentClient = owner.client;

    // Server-side filter is requested, but simulate it failing: response
    // includes a foreign-profile account. The defensive post-filter must drop it.
    listAccounts.mockResolvedValue({
      data: {
        accounts: [
          { _id: `acc-${bound}-ok`, platform: "instagram", username: "mine", profileId: bound },
          { _id: `acc-foreign`, platform: "instagram", username: "theirs", profileId: "other-profile" },
          // populated-Profile variant must also be handled
          { _id: `acc-${bound}-pop`, platform: "facebook", username: "mine2", profileId: { _id: bound, name: "X" } },
        ],
      },
    });

    const res = await syncPOST(syncReq());
    expect(res.status).toBe(200);

    expect(listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ profileId: bound }) })
    );

    const { data: channels } = await serviceClient()
      .from("channels")
      .select("late_account_id")
      .eq("workspace_id", owner.workspaceId);

    const ids = (channels ?? []).map((c) => c.late_account_id).sort();
    expect(ids).toEqual([`acc-${bound}-ok`, `acc-${bound}-pop`].sort());
  });
});

// Defect 3 (2026-08-24): channels/route, channels/sync and channels/connect each
// rolled their own workspace lookup — workspace_members .eq(user_id) .limit(1)
// .single(), i.e. the user's FIRST membership, no ordering — so the workspace
// switcher changed nothing for them and a Facebook OAuth landed in the wrong
// workspace. This test fails against that old code and passes against
// authorizeApiV1, so the defect cannot come back unnoticed.
describe("workspace switcher scoping (Defect 3)", () => {
  it("channels GET returns the SELECTED workspace's rows, not the first membership's", async () => {
    const owner = await createTestUser("ps-switch");
    currentClient = owner.client;
    const svc = serviceClient();

    // A second workspace for the SAME user, created after the auto-made first one.
    const stamp = `${Date.now()}-${Math.round(performance.now())}`;
    const { data: second, error: wsErr } = await svc
      .from("workspaces")
      .insert({ name: `Second ${stamp}`, slug: `second-${stamp}` })
      .select("id")
      .single();
    expect(wsErr).toBeNull();
    await svc
      .from("workspace_members")
      .insert({ workspace_id: second!.id, user_id: owner.userId, role: "owner" });

    // One distinct channel row in each workspace (ids differ — an account is
    // ACTIVE in only one workspace at a time, per the global uniqueness index).
    const firstAcc = `acc-first-${stamp}`;
    const secondAcc = `acc-second-${stamp}`;
    await svc.from("channels").insert([
      {
        workspace_id: owner.workspaceId,
        platform: "instagram" as const,
        late_account_id: firstAcc,
        is_active: true,
      },
      {
        workspace_id: second!.id,
        platform: "instagram" as const,
        late_account_id: secondAcc,
        is_active: true,
      },
    ]);

    // The switcher selects the SECOND workspace.
    currentCookies = { zernflow_workspace_id: second!.id };

    const res = await channelsGET(channelsReq());
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ late_account_id: string }>;
    expect(rows.map((r) => r.late_account_id)).toEqual([secondAcc]);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

import { encryptSecret } from "@/lib/crypto";
function encryptedKeyFor(workspaceId: string): string {
  return encryptSecret("test-key-value", workspaceId);
}

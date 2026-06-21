import { describe, it, expect, vi, beforeEach } from "vitest";
import { serviceClient, createTestUser } from "./helpers";
import { isEncrypted } from "@/lib/crypto";

// No real Zernio traffic — same seam as the test-key route test.
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

import { onboardClient, deriveSlug, OnboardError } from "@/lib/onboard";

// Profile<->workspace binding and active accounts are globally unique (00011),
// so each test must use fresh ids and a fresh workspace name.
let testProfileId = "";
let testAccountId = "";
let testName = "";

beforeEach(() => {
  testProfileId = `prof-${crypto.randomUUID()}`;
  testAccountId = `acc-${crypto.randomUUID()}`;
  testName = `Client ${crypto.randomUUID()}`;

  listProfiles.mockReset();
  listProfiles.mockResolvedValue({ data: { profiles: [{ _id: testProfileId, name: "Default" }] } });
  listAccounts.mockReset();
  listAccounts.mockResolvedValue({
    data: {
      accounts: [
        {
          _id: testAccountId,
          platform: "instagram",
          username: "client_ig",
          displayName: "Client IG",
          profileId: testProfileId,
        },
      ],
    },
  });
  createWebhookSettings.mockReset();
  createWebhookSettings.mockResolvedValue({ data: { webhook: { _id: `wh-${crypto.randomUUID()}` } } });
  deleteWebhookSettings.mockReset();
  deleteWebhookSettings.mockResolvedValue({ data: { success: true } });
});

const baseInput = (over: Record<string, unknown> = {}) => ({
  name: testName,
  ownerUserId: "",
  zernioApiKey: "zern-client-key",
  appUrl: "https://os.test/engage",
  ...over,
});

describe("onboardClient", () => {
  it("deriveSlug lowercases, collapses non-alphanumerics, trims hyphens", () => {
    expect(deriveSlug("  Acme & Co!! ")).toBe("acme-co");
    expect(deriveSlug("Already-Good")).toBe("already-good");
  });

  it("stands up a full tenant: workspace+owner, profile bound, channel synced, scoped key, webhook", async () => {
    const owner = await createTestUser("ob-full");
    const db = serviceClient();

    const res = await onboardClient(baseInput({ ownerUserId: owner.userId }), db);

    expect(res.workspaceCreated).toBe(true);
    expect(res.slug).toBe(deriveSlug(testName));
    expect(res.profile).toEqual({ id: testProfileId, name: "Default", bound: "created" });
    expect(res.channelsSynced).toBe(1);
    expect(res.ownerMembership).toBe("created");
    expect(res.operatorMembership).toBe("skipped");
    expect(res.apiKey.issued).toBe(true);
    expect(res.apiKey.key?.startsWith("zf_")).toBe(true);
    expect(res.apiKey.scopes).toEqual(["read"]);
    expect(res.webhook.ok).toBe(true);

    // Workspace + owner membership.
    const { data: ws } = await db
      .from("workspaces")
      .select("id, slug, zernio_profile_id, zernio_profile_name, late_api_key_encrypted, webhook_token_hash, zernio_webhook_id")
      .eq("id", res.workspaceId)
      .single();
    expect(ws?.slug).toBe(deriveSlug(testName));
    expect(ws?.zernio_profile_id).toBe(testProfileId);
    expect(ws?.zernio_profile_name).toBe("Default");

    const { data: members } = await db
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", res.workspaceId);
    expect(members).toEqual([{ user_id: owner.userId, role: "owner" }]);

    // Zernio key stored encrypted, never plaintext.
    expect(isEncrypted(ws?.late_api_key_encrypted)).toBe(true);
    expect(ws?.late_api_key_encrypted).not.toContain("zern-client-key");

    // Channel synced for the bound account.
    const { data: channels } = await db
      .from("channels")
      .select("late_account_id, workspace_id")
      .eq("workspace_id", res.workspaceId);
    expect(channels).toHaveLength(1);
    expect(channels?.[0].late_account_id).toBe(testAccountId);

    // Scoped key persisted (metadata only).
    const { data: keys } = await db
      .from("api_keys")
      .select("name, scopes, key_prefix")
      .eq("workspace_id", res.workspaceId);
    expect(keys).toHaveLength(1);
    expect(keys?.[0].name).toBe("onboarding");
    expect(keys?.[0].scopes).toEqual(["read"]);

    // Webhook registered (token hashed, id stored).
    expect(ws?.webhook_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ws?.zernio_webhook_id).toBeTruthy();
    expect(createWebhookSettings).toHaveBeenCalledTimes(1);
    expect(createWebhookSettings.mock.calls[0][0].body.events).toEqual([
      "message.received",
      "comment.received",
    ]);
    expect(createWebhookSettings.mock.calls[0][0].body.url).toContain(
      "https://os.test/engage/api/webhooks/zernio/"
    );
  });

  it("is idempotent on re-run: no duplicate workspace, member, channel, or key", async () => {
    const owner = await createTestUser("ob-idem");
    const db = serviceClient();
    const input = baseInput({ ownerUserId: owner.userId });

    const first = await onboardClient(input, db);
    const second = await onboardClient(input, db);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.workspaceCreated).toBe(false);
    expect(second.profile.bound).toBe("existing");
    expect(second.ownerMembership).toBe("existing");
    expect(second.apiKey.issued).toBe(false); // raw secret can't be re-shown
    expect(second.apiKey.key).toBeUndefined();

    const { count: wsCount } = await db
      .from("workspaces")
      .select("id", { count: "exact", head: true })
      .eq("slug", first.slug);
    expect(wsCount).toBe(1);

    const { count: memberCount } = await db
      .from("workspace_members")
      .select("user_id", { count: "exact", head: true })
      .eq("workspace_id", first.workspaceId);
    expect(memberCount).toBe(1);

    const { count: channelCount } = await db
      .from("channels")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", first.workspaceId);
    expect(channelCount).toBe(1);

    const { count: keyCount } = await db
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", first.workspaceId);
    expect(keyCount).toBe(1);
  });

  it("adds an operator membership distinct from the owner", async () => {
    const owner = await createTestUser("ob-owner");
    const operator = await createTestUser("ob-operator");
    const db = serviceClient();

    const res = await onboardClient(
      baseInput({ ownerUserId: owner.userId, operatorUserId: operator.userId }),
      db
    );
    expect(res.operatorMembership).toBe("added");

    const { data: members } = await db
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", res.workspaceId);
    expect(members).toHaveLength(2);
    expect(members).toEqual(
      expect.arrayContaining([
        { user_id: owner.userId, role: "owner" },
        { user_id: operator.userId, role: "operator" },
      ])
    );
  });

  it("skips the operator membership when it equals the owner", async () => {
    const owner = await createTestUser("ob-self");
    const db = serviceClient();
    const res = await onboardClient(
      baseInput({ ownerUserId: owner.userId, operatorUserId: owner.userId }),
      db
    );
    expect(res.operatorMembership).toBe("skipped");
    const { count } = await db
      .from("workspace_members")
      .select("user_id", { count: "exact", head: true })
      .eq("workspace_id", res.workspaceId);
    expect(count).toBe(1);
  });

  it("issues a key with explicit scopes when provided", async () => {
    const owner = await createTestUser("ob-scopes");
    const db = serviceClient();
    const res = await onboardClient(
      baseInput({ ownerUserId: owner.userId, keyScopes: ["read", "send"] }),
      db
    );
    expect(res.apiKey.scopes).toEqual(["read", "send"]);
    const { data: key } = await db
      .from("api_keys")
      .select("scopes")
      .eq("id", res.apiKey.keyId!)
      .single();
    expect(key?.scopes).toEqual(["read", "send"]);
  });

  it("refuses to bind (PROFILE_CHOICE_REQUIRED) when the key sees multiple profiles and none is chosen", async () => {
    const owner = await createTestUser("ob-multi");
    const db = serviceClient();
    listProfiles.mockResolvedValue({
      data: { profiles: [{ _id: testProfileId, name: "A" }, { _id: `prof-${crypto.randomUUID()}`, name: "B" }] },
    });

    await expect(onboardClient(baseInput({ ownerUserId: owner.userId }), db)).rejects.toMatchObject({
      name: "OnboardError",
      code: "PROFILE_CHOICE_REQUIRED",
    });
  });

  it("never echoes the Zernio key in a bind error", async () => {
    const owner = await createTestUser("ob-sdkerr");
    const db = serviceClient();
    listAccounts.mockRejectedValue(new Error("auth failed for key zern-secret-echo"));

    let thrown: unknown;
    try {
      await onboardClient(baseInput({ ownerUserId: owner.userId, zernioApiKey: "zern-secret-echo" }), db);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OnboardError);
    expect((thrown as Error).message).not.toContain("zern-secret-echo");
  });

  it("surfaces a webhook warning without failing onboarding when registration fails", async () => {
    const owner = await createTestUser("ob-whfail");
    const db = serviceClient();
    createWebhookSettings.mockRejectedValue(new Error("403 scoped key cannot manage webhooks"));

    const res = await onboardClient(baseInput({ ownerUserId: owner.userId }), db);

    expect(res.apiKey.issued).toBe(true); // earlier steps still succeeded
    expect(res.profile.bound).toBe("created");
    expect(res.webhook.ok).toBe(false);
    expect(res.webhook.warning).toBeTruthy();
    expect(JSON.stringify(res)).not.toContain("scoped key cannot manage"); // no SDK echo

    const { data: ws } = await db
      .from("workspaces")
      .select("zernio_webhook_id")
      .eq("id", res.workspaceId)
      .single();
    expect(ws?.zernio_webhook_id).toBeNull();
  });
});

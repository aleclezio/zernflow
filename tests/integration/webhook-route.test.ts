import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac, randomBytes } from "node:crypto";
import { anonClient, serviceClient, createTestUser } from "./helpers";
import { setWebhookCredentials } from "@/lib/workspace-keys";
import { sha256Hex } from "@/lib/webhook-verify";
import { _resetRateLimits } from "@/lib/rate-limit";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => anonClient(),
  createServiceClient: async () => serviceClient(),
}));

import { POST } from "@/app/api/webhooks/zernio/[token]/route";

interface WebhookRig {
  workspaceId: string;
  accountId: string;
  token: string;
  secret: string;
}

async function setupRig(label: string): Promise<WebhookRig> {
  const owner = await createTestUser(`wh-${label}`);
  const token = randomBytes(32).toString("base64url");
  const secret = randomBytes(32).toString("base64url");

  const { error } = await setWebhookCredentials(serviceClient(), owner.workspaceId, {
    tokenHash: sha256Hex(token),
    secret,
    zernioWebhookId: null,
  });
  expect(error).toBeNull();

  const accountId = `acc-${crypto.randomUUID()}`;
  const { error: chErr } = await serviceClient().from("channels").insert({
    workspace_id: owner.workspaceId,
    platform: "instagram",
    late_account_id: accountId,
    is_active: true,
  });
  expect(chErr).toBeNull();

  return { workspaceId: owner.workspaceId, accountId, token, secret };
}

function makePayload(accountId: string, overrides: Record<string, unknown> = {}) {
  const senderId = `sender-${crypto.randomUUID()}`;
  return {
    id: `evt-${crypto.randomUUID()}`,
    event: "message.received",
    message: {
      id: "m1",
      conversationId: `conv-${crypto.randomUUID()}`,
      platform: "instagram",
      platformMessageId: "pm1",
      direction: "inbound",
      text: "hello",
      attachments: [],
      sender: { id: senderId, name: "Visitor", username: null, picture: null },
      sentAt: new Date().toISOString(),
      isRead: false,
    },
    conversation: {
      id: `conv-${crypto.randomUUID()}`,
      platformConversationId: null,
      participantId: senderId,
      participantName: "Visitor",
      participantUsername: null,
      participantPicture: null,
      status: "open",
    },
    account: { id: accountId, platform: "instagram", username: "biz", displayName: "Biz" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function send(
  token: string,
  rawBody: string,
  headers: Record<string, string> = {}
) {
  const req = new NextRequest(`http://localhost:3000/api/webhooks/zernio/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
  return POST(req, { params: Promise.resolve({ token }) });
}

function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function contactCount(workspaceId: string): Promise<number> {
  const { count } = await serviceClient()
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  return count ?? 0;
}

beforeEach(() => {
  _resetRateLimits();
});

describe("POST /api/webhooks/zernio/[token]", () => {
  it("404s on an unknown token without any processing", async () => {
    const body = JSON.stringify({ whatever: true });
    const res = await send(randomBytes(32).toString("base64url"), body, {
      "x-zernio-signature": "0".repeat(64),
    });
    expect(res.status).toBe(404);
  });

  it("401s an UNSIGNED event and writes nothing", async () => {
    const rig = await setupRig("unsigned");
    const body = JSON.stringify(makePayload(rig.accountId));

    const res = await send(rig.token, body);

    expect(res.status).toBe(401);
    expect(await contactCount(rig.workspaceId)).toBe(0);
  });

  it("401s a BAD signature and writes nothing", async () => {
    const rig = await setupRig("badsig");
    const body = JSON.stringify(makePayload(rig.accountId));

    const res = await send(rig.token, body, {
      "x-zernio-signature": sign(body, "not-the-secret"),
    });

    expect(res.status).toBe(401);
    expect(await contactCount(rig.workspaceId)).toBe(0);
  });

  it("401s (not 500) on a length-mismatched signature", async () => {
    const rig = await setupRig("lensig");
    const body = JSON.stringify(makePayload(rig.accountId));

    const res = await send(rig.token, body, { "x-zernio-signature": "deadbeef" });

    expect(res.status).toBe(401);
  });

  it("401s when the workspace has no webhook secret (secret is mandatory)", async () => {
    const owner = await createTestUser("wh-nosecret");
    const token = randomBytes(32).toString("base64url");
    // token registered but secret missing
    await serviceClient()
      .from("workspaces")
      .update({ webhook_token_hash: sha256Hex(token) })
      .eq("id", owner.workspaceId);

    const body = JSON.stringify(makePayload("acc-any"));
    const res = await send(token, body, { "x-zernio-signature": "0".repeat(64) });

    expect(res.status).toBe(401);
  });

  it("processes a correctly signed event: contact + conversation created", async () => {
    const rig = await setupRig("happy");
    const payload = makePayload(rig.accountId);
    const body = JSON.stringify(payload);

    const res = await send(rig.token, body, { "x-zernio-signature": sign(body, rig.secret) });

    expect(res.status).toBe(200);
    expect(await contactCount(rig.workspaceId)).toBe(1);

    const { data: convs } = await serviceClient()
      .from("conversations")
      .select("late_conversation_id")
      .eq("workspace_id", rig.workspaceId);
    expect(convs).toHaveLength(1);
    expect(convs?.[0].late_conversation_id).toBe(payload.conversation.id);
  });

  it("accepts the legacy x-late-signature alias when canonical is absent", async () => {
    const rig = await setupRig("legacyhdr");
    const body = JSON.stringify(makePayload(rig.accountId));

    const res = await send(rig.token, body, { "x-late-signature": sign(body, rig.secret) });

    expect(res.status).toBe(200);
    expect(await contactCount(rig.workspaceId)).toBe(1);
  });

  it("deduplicates replayed events: same event id processes exactly once", async () => {
    const rig = await setupRig("replay");
    const payload = makePayload(rig.accountId);
    const body = JSON.stringify(payload);
    const sig = sign(body, rig.secret);

    const first = await send(rig.token, body, { "x-zernio-signature": sig });
    expect(first.status).toBe(200);

    const second = await send(rig.token, body, { "x-zernio-signature": sig });
    expect(second.status).toBe(200);
    const dup = await second.json();
    expect(dup.duplicate).toBe(true);

    expect(await contactCount(rig.workspaceId)).toBe(1);
  });

  it("200-skips unknown accounts (never 404 — Zernio auto-disables after 10 failures)", async () => {
    const rig = await setupRig("unknownacc");
    const body = JSON.stringify(makePayload(`acc-foreign-${crypto.randomUUID()}`));

    const res = await send(rig.token, body, { "x-zernio-signature": sign(body, rig.secret) });

    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.skipped).toBe(true);
    expect(await contactCount(rig.workspaceId)).toBe(0);
  });

  it("never routes cross-tenant: workspace A's token cannot write into workspace B", async () => {
    const rigA = await setupRig("xtenant-a");
    const rigB = await setupRig("xtenant-b");

    // Signed with A's secret, hitting A's token, but referencing B's account.
    const body = JSON.stringify(makePayload(rigB.accountId));
    const res = await send(rigA.token, body, {
      "x-zernio-signature": sign(body, rigA.secret),
    });

    expect(res.status).toBe(200); // skipped — B's account is not A's channel
    expect(await contactCount(rigA.workspaceId)).toBe(0);
    expect(await contactCount(rigB.workspaceId)).toBe(0);
  });

  it("400s signed-but-invalid JSON (parse happens only after verification)", async () => {
    const rig = await setupRig("badjson");
    const body = "{not json";

    const res = await send(rig.token, body, { "x-zernio-signature": sign(body, rig.secret) });

    expect(res.status).toBe(400);
  });

  it("200-skips non-message events and outbound messages", async () => {
    const rig = await setupRig("skips");

    const other = JSON.stringify(makePayload(rig.accountId, { event: "post.published" }));
    const r1 = await send(rig.token, other, { "x-zernio-signature": sign(other, rig.secret) });
    expect(r1.status).toBe(200);
    expect((await r1.json()).skipped).toBe(true);

    const base = makePayload(rig.accountId);
    const outbound = JSON.stringify({
      ...base,
      message: { ...base.message, direction: "outbound" },
    });
    const r2 = await send(rig.token, outbound, {
      "x-zernio-signature": sign(outbound, rig.secret),
    });
    expect(r2.status).toBe(200);
    expect((await r2.json()).skipped).toBe(true);

    expect(await contactCount(rig.workspaceId)).toBe(0);
  });
});

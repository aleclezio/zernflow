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

interface Rig {
  workspaceId: string;
  channelId: string;
  accountId: string;
  channelUsername: string;
  token: string;
  secret: string;
}

async function setupRig(label: string): Promise<Rig> {
  const owner = await createTestUser(`cm-${label}`);
  const token = randomBytes(32).toString("base64url");
  const secret = randomBytes(32).toString("base64url");

  const { error } = await setWebhookCredentials(serviceClient(), owner.workspaceId, {
    tokenHash: sha256Hex(token),
    secret,
    zernioWebhookId: null,
  });
  expect(error).toBeNull();

  const accountId = `acc-${crypto.randomUUID()}`;
  const channelUsername = `biz_${label}`;
  const { data: channel, error: chErr } = await serviceClient()
    .from("channels")
    .insert({
      workspace_id: owner.workspaceId,
      platform: "instagram",
      late_account_id: accountId,
      username: channelUsername,
      is_active: true,
    })
    .select("id")
    .single();
  expect(chErr).toBeNull();

  return {
    workspaceId: owner.workspaceId,
    channelId: channel!.id,
    accountId,
    channelUsername,
    token,
    secret,
  };
}

async function createCommentRule(
  rig: Rig,
  opts: { keywords: Array<{ value: string; matchType?: string }>; postIds?: string[] }
): Promise<string> {
  const { data: flow } = await serviceClient()
    .from("flows")
    .insert({ workspace_id: rig.workspaceId, name: "pilot comment flow", status: "published" })
    .select("id")
    .single();

  const { data: trigger, error } = await serviceClient()
    .from("triggers")
    .insert({
      flow_id: flow!.id,
      channel_id: rig.channelId,
      type: "comment_keyword",
      config: { keywords: opts.keywords, ...(opts.postIds ? { postIds: opts.postIds } : {}) },
      is_active: true,
      priority: 10,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return trigger!.id;
}

function makeComment(
  accountId: string,
  overrides: { text?: string; platformPostId?: string; authorUsername?: string; eventId?: string } = {}
) {
  return {
    id: overrides.eventId ?? `evt-${crypto.randomUUID()}`,
    event: "comment.received",
    comment: {
      id: `cmt-${crypto.randomUUID()}`,
      postId: null,
      platformPostId: overrides.platformPostId ?? "POST-1",
      platform: "instagram",
      text: overrides.text ?? "please send me INFO",
      author: {
        id: `author-${crypto.randomUUID()}`,
        username: overrides.authorUsername ?? "a_visitor",
        name: "A Visitor",
        picture: null,
      },
      createdAt: new Date().toISOString(),
      isReply: false,
      parentCommentId: null,
    },
    post: { id: null, platformPostId: overrides.platformPostId ?? "POST-1" },
    account: { id: accountId, platform: "instagram", username: "biz" },
    timestamp: new Date().toISOString(),
  };
}

function send(token: string, rawBody: string, headers: Record<string, string> = {}) {
  const req = new NextRequest(`http://localhost:3000/api/webhooks/zernio/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
  return POST(req, { params: Promise.resolve({ token }) });
}

const sign = (rawBody: string, secret: string) =>
  createHmac("sha256", secret).update(rawBody).digest("hex");

async function contactCount(workspaceId: string): Promise<number> {
  const { count } = await serviceClient()
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  return count ?? 0;
}

async function commentLogs(workspaceId: string) {
  const { data } = await serviceClient()
    .from("comment_logs")
    .select("matched_trigger_id, platform_comment_id, comment_text")
    .eq("workspace_id", workspaceId);
  return data ?? [];
}

beforeEach(() => {
  _resetRateLimits();
});

describe("POST /api/webhooks/zernio/[token] — comment.received", () => {
  it("logs an unmatched comment and creates no contact when no rule matches", async () => {
    const rig = await setupRig("nomatch");
    const body = JSON.stringify(makeComment(rig.accountId, { text: "just a normal comment" }));

    const res = await send(rig.token, body, { "x-zernio-signature": sign(body, rig.secret) });

    expect(res.status).toBe(200);
    expect((await res.json()).matched).toBe(false);
    const logs = await commentLogs(rig.workspaceId);
    expect(logs).toHaveLength(1);
    expect(logs[0].matched_trigger_id).toBeNull();
    expect(await contactCount(rig.workspaceId)).toBe(0);
  });

  it("matches a comment_keyword rule: creates the commenter contact and logs the match", async () => {
    const rig = await setupRig("match");
    const triggerId = await createCommentRule(rig, { keywords: [{ value: "info", matchType: "contains" }] });
    const body = JSON.stringify(makeComment(rig.accountId, { text: "Please send me INFO now" }));

    const res = await send(rig.token, body, { "x-zernio-signature": sign(body, rig.secret) });

    expect(res.status).toBe(200);
    expect((await res.json()).matched).toBe(true);
    expect(await contactCount(rig.workspaceId)).toBe(1);
    const logs = await commentLogs(rig.workspaceId);
    expect(logs).toHaveLength(1);
    expect(logs[0].matched_trigger_id).toBe(triggerId);
  });

  it("respects per-post scoping: a rule bound to other posts does not match", async () => {
    const rig = await setupRig("postscope");
    await createCommentRule(rig, { keywords: [{ value: "info" }], postIds: ["OTHER-POST"] });
    const body = JSON.stringify(makeComment(rig.accountId, { text: "info", platformPostId: "POST-1" }));

    const res = await send(rig.token, body, { "x-zernio-signature": sign(body, rig.secret) });

    expect(res.status).toBe(200);
    expect((await res.json()).matched).toBe(false);
    expect(await contactCount(rig.workspaceId)).toBe(0);
  });

  it("deduplicates a replayed comment event", async () => {
    const rig = await setupRig("dedupe");
    await createCommentRule(rig, { keywords: [{ value: "info" }] });
    const body = JSON.stringify(makeComment(rig.accountId, { text: "info", eventId: "evt-fixed-1" }));
    const sig = sign(body, rig.secret);

    const first = await send(rig.token, body, { "x-zernio-signature": sig });
    expect(first.status).toBe(200);

    const second = await send(rig.token, body, { "x-zernio-signature": sig });
    expect((await second.json()).duplicate).toBe(true);
    expect(await contactCount(rig.workspaceId)).toBe(1);
  });

  it("ignores comments authored by the workspace's own connected account (loop guard)", async () => {
    const rig = await setupRig("loop");
    await createCommentRule(rig, { keywords: [{ value: "info" }] });
    const body = JSON.stringify(
      makeComment(rig.accountId, { text: "info", authorUsername: rig.channelUsername })
    );

    const res = await send(rig.token, body, { "x-zernio-signature": sign(body, rig.secret) });

    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
    expect(await contactCount(rig.workspaceId)).toBe(0);
  });

  it("never routes cross-tenant: A's token cannot process a comment on B's account", async () => {
    const rigA = await setupRig("xt-a");
    const rigB = await setupRig("xt-b");
    await createCommentRule(rigB, { keywords: [{ value: "info" }] });

    const body = JSON.stringify(makeComment(rigB.accountId, { text: "info" }));
    const res = await send(rigA.token, body, { "x-zernio-signature": sign(body, rigA.secret) });

    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
    expect(await contactCount(rigA.workspaceId)).toBe(0);
    expect(await contactCount(rigB.workspaceId)).toBe(0);
  });
});

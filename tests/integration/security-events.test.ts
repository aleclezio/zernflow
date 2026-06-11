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

import { POST as webhookPOST } from "@/app/api/webhooks/zernio/[token]/route";
import { GET as cronGET } from "@/app/api/cron/jobs/route";

function send(token: string, rawBody: string, headers: Record<string, string> = {}) {
  const req = new NextRequest(`http://localhost:3000/api/webhooks/zernio/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
  return webhookPOST(req, { params: Promise.resolve({ token }) });
}

async function eventsFor(workspaceId: string | null, type: string): Promise<number> {
  let q = serviceClient()
    .from("security_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", type);
  q = workspaceId === null ? q.is("workspace_id", null) : q.eq("workspace_id", workspaceId);
  const { count } = await q;
  return count ?? 0;
}

beforeEach(() => {
  _resetRateLimits();
});

describe("security_events audit log", () => {
  it("is service-role only", async () => {
    const user = await createTestUser("se-rls");
    const { data, error } = await user.client.from("security_events").select("id").limit(1);
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  it("records webhook signature rejections and replays", async () => {
    const owner = await createTestUser("se-webhook");
    const token = randomBytes(32).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    await setWebhookCredentials(serviceClient(), owner.workspaceId, {
      tokenHash: sha256Hex(token),
      secret,
      zernioWebhookId: null,
    });

    const body = JSON.stringify({ id: `evt-${crypto.randomUUID()}`, event: "message.received", message: { direction: "inbound", sender: {} }, conversation: {}, account: { id: "none" } });

    // bad signature -> webhook_sig_rejected
    const bad = await send(token, body, { "x-zernio-signature": "0".repeat(64) });
    expect(bad.status).toBe(401);
    expect(await eventsFor(owner.workspaceId, "webhook_sig_rejected")).toBe(1);

    // valid then replay -> webhook_replay
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    await send(token, body, { "x-zernio-signature": sig });
    const replay = await send(token, body, { "x-zernio-signature": sig });
    expect(replay.status).toBe(200);
    expect(await eventsFor(owner.workspaceId, "webhook_replay")).toBe(1);
  });

  it("records cron auth failures", async () => {
    const before = await eventsFor(null, "cron_auth_failed");
    const res = await cronGET(
      new NextRequest("http://localhost:3000/api/cron/jobs", {
        headers: { authorization: "Bearer wrong" },
      })
    );
    expect(res.status).toBe(401);
    expect(await eventsFor(null, "cron_auth_failed")).toBe(before + 1);
  });
});

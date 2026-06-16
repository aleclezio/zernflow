import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { anonClient, serviceClient, createTestUser } from "./helpers";

// Same seam as v1-scopes: api-key path → real service client (bypasses RLS).
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

// Controllable Zernio SDK: throw a set error, else succeed.
const zstate = vi.hoisted(() => ({ throwErr: null as Error | null }));
vi.mock("@/lib/zernio-client", () => ({
  createZernioClient: () => ({
    messages: {
      sendInboxMessage: async () => {
        if (zstate.throwErr) throw zstate.throwErr;
        return { data: { data: { messageId: "mid-123" } } };
      },
    },
  }),
}));

import { POST as messagesPOST } from "@/app/api/v1/messages/route";
import { setZernioKey } from "@/lib/workspace-keys";
import { _resetRateLimits } from "@/lib/rate-limit";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY = "zf_sendobs0000000000000000000000a";
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function windowError(): Error {
  const e = new Error("This message is sent outside of allowed window.") as Error & { statusCode: number };
  e.statusCode = 403;
  return e;
}

/** Fresh workspace + send-scoped key + channel + conversation (inbound 1h ago). */
async function seed(opts: { withLateId?: boolean } = {}) {
  const svc = serviceClient();
  const { workspaceId, userId } = await createTestUser("sendobs");
  await svc.from("api_keys").insert({
    workspace_id: workspaceId, name: "sendobs key",
    key_hash: sha256(KEY), key_prefix: KEY.slice(0, 12) + "...",
    created_by: userId, scopes: ["send"],
  });
  await setZernioKey(svc, workspaceId, "fake-zernio-key");
  const { data: contact } = await svc.from("contacts")
    .insert({ workspace_id: workspaceId, display_name: "c" }).select("id").single();
  const { data: channel } = await svc.from("channels")
    .insert({ workspace_id: workspaceId, platform: "instagram", late_account_id: `acc-${randomUUID()}`, is_active: true })
    .select("id").single();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: conv } = await svc.from("conversations")
    .insert({
      workspace_id: workspaceId, channel_id: channel!.id, contact_id: contact!.id,
      platform: "instagram",
      late_conversation_id: opts.withLateId === false ? null : `late-${randomUUID()}`,
      last_inbound_at: oneHourAgo,
    })
    .select("id").single();
  return { workspaceId, conversationId: conv!.id };
}

async function attemptsFor(workspaceId: string) {
  const { data } = await serviceClient()
    .from("send_attempts").select("*").eq("workspace_id", workspaceId);
  return data ?? [];
}

describe("send observability", () => {
  beforeEach(() => {
    zstate.throwErr = null;
    _resetRateLimits();
  });

  it("records a SUCCESS attempt with the window-age field", async () => {
    const { workspaceId, conversationId } = await seed();
    const res = await messagesPOST(post({ conversationId, text: "hi there" }));
    expect(res.status).toBe(201);

    const rows = await attemptsFor(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].http_status).toBe(201);
    expect(rows[0].text_length).toBe("hi there".length);
    expect(rows[0].ms_since_last_inbound).toBeGreaterThan(0);
  });

  it("maps the Instagram window 403 to a SAFE message and records the raw error", async () => {
    const { workspaceId, conversationId } = await seed();
    zstate.throwErr = windowError();

    const res = await messagesPOST(post({ conversationId, text: "late reply" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    // safe, mapped message — NOT the verbatim SDK text (invariant #1)
    expect(body.error).toMatch(/window|24 hour/i);
    expect(body.error).not.toMatch(/outside of allowed window/);
    expect(body.windowExpired).toBe(true);

    const rows = await attemptsFor(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("zernio_error");
    expect(rows[0].zernio_status).toBe(403);
    // raw error kept server-side for debugging
    expect(rows[0].error_message).toContain("outside of allowed window");
    expect(rows[0].ms_since_last_inbound).toBeGreaterThan(0);
  });

  it("records the silent guard case (conversation missing a Zernio id) that the old code never logged", async () => {
    const { workspaceId, conversationId } = await seed({ withLateId: false });
    const res = await messagesPOST(post({ conversationId, text: "x" }));
    expect(res.status).toBe(400);

    const rows = await attemptsFor(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("guard_no_late_id");
  });
});

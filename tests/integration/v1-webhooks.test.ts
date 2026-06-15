import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac, createHash } from "node:crypto";
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

// Capture outbound deliveries instead of hitting the network.
const sf = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; headers: Record<string, string>; body: string }>,
  status: 200,
  throwKind: null as null | "ssrf" | "net",
}));
vi.mock("@/lib/flow-engine/safe-fetch", () => {
  class SsrfError extends Error {}
  return {
    SsrfError,
    safeFetch: async (
      url: string,
      init: { method: string; headers?: Record<string, string>; body?: string }
    ) => {
      sf.calls.push({ url, headers: init.headers ?? {}, body: init.body ?? "" });
      if (sf.throwKind === "ssrf") throw new SsrfError("blocked");
      if (sf.throwKind === "net") throw new Error("network");
      return { status: sf.status, bodyText: "" };
    },
  };
});

import { GET as listGET, POST as createPOST } from "@/app/api/v1/webhook-endpoints/route";
import { PUT as updatePUT, DELETE as deleteDELETE } from "@/app/api/v1/webhook-endpoints/[endpointId]/route";
import { POST as testPOST } from "@/app/api/v1/webhook-endpoints/[endpointId]/test/route";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { setWebhookEndpointSecret } from "@/lib/workspace-keys";
import { isEncrypted } from "@/lib/crypto";

const jsonReq = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/webhook-endpoints", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const plainReq = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/webhook-endpoints", { headers });
const params = (endpointId: string) => ({ params: Promise.resolve({ endpointId }) });

let ownerA: { workspaceId: string; client: unknown };
let ownerB: { workspaceId: string };
let member: { client: unknown };

async function makeEndpoint(
  workspaceId: string,
  opts: { url?: string; events: string[]; secret?: string | null; isActive?: boolean; failureCount?: number }
): Promise<string> {
  const { data } = await serviceClient()
    .from("webhook_endpoints")
    .insert({
      workspace_id: workspaceId,
      url: opts.url ?? "https://hook.example.com/in",
      name: "ep",
      events: opts.events,
      is_active: opts.isActive ?? true,
      failure_count: opts.failureCount ?? 0,
    })
    .select("id")
    .single();
  if (opts.secret !== undefined) {
    await setWebhookEndpointSecret(serviceClient(), workspaceId, data!.id, opts.secret);
  }
  return data!.id;
}

const asAdminA = () => {
  session.client = ownerA.client;
  cookie.workspaceId = ownerA.workspaceId;
};

beforeAll(async () => {
  const a = await createTestUser("wh-A");
  const b = await createTestUser("wh-B");
  const m = await createTestUser("wh-member");
  ownerA = { workspaceId: a.workspaceId, client: a.client };
  ownerB = { workspaceId: b.workspaceId };
  member = { client: m.client };
  await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: a.workspaceId, user_id: m.userId, role: "member" });
});

beforeEach(async () => {
  session.client = null;
  cookie.workspaceId = undefined;
  sf.calls = [];
  sf.status = 200;
  sf.throwKind = null;
  await serviceClient().from("webhook_endpoints").delete().eq("workspace_id", ownerA.workspaceId);
  await serviceClient().from("webhook_endpoints").delete().eq("workspace_id", ownerB.workspaceId);
});

describe("/api/v1/webhook-endpoints — management", () => {
  it("creates an endpoint, returns the signing secret once, stores it encrypted, list excludes it", async () => {
    asAdminA();
    const res = await createPOST(
      jsonReq({ url: "https://hook.example.com/x", name: "CRM", events: ["flow.started", "tag.added"] })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{48}$/); // auto-generated, shown once
    expect(body.data).not.toHaveProperty("secret_encrypted");
    expect(body.data).not.toHaveProperty("secret");

    // Stored ciphertext is encrypted at rest (custody invariant).
    const { data: row } = await serviceClient()
      .from("webhook_endpoints")
      .select("secret_encrypted")
      .eq("id", body.data.id)
      .single();
    expect(isEncrypted(row!.secret_encrypted)).toBe(true);

    // List returns metadata only — never the secret.
    const listRes = await listGET(plainReq());
    const listed = (await listRes.json()).data.find((r: { id: string }) => r.id === body.data.id);
    expect(listed.events).toEqual(["flow.started", "tag.added"]);
    expect(listed).not.toHaveProperty("secret_encrypted");
  });

  it("honors a caller-supplied secret instead of auto-generating", async () => {
    asAdminA();
    const res = await createPOST(
      jsonReq({ url: "https://hook.example.com/y", name: "n", events: ["flow.started"], secret: "my-own-secret" })
    );
    const body = await res.json();
    expect(body.secret).toBe("my-own-secret");
  });

  it("rejects a non-https url (400) and an unknown event type (400)", async () => {
    asAdminA();
    expect(
      (await createPOST(jsonReq({ url: "http://insecure.example", name: "n", events: ["flow.started"] }))).status
    ).toBe(400);
    expect(
      (await createPOST(jsonReq({ url: "https://ok.example", name: "n", events: ["conversation.opened"] }))).status
    ).toBe(400);
  });

  it("an API key cannot manage webhooks (403)", async () => {
    const raw = "zf_" + "a".repeat(48);
    await serviceClient().from("api_keys").insert({
      workspace_id: ownerA.workspaceId,
      name: "wh-test",
      key_hash: createHash("sha256").update(raw).digest("hex"),
      key_prefix: "zf_a...",
    });
    expect((await listGET(plainReq({ authorization: `Bearer ${raw}` }))).status).toBe(403);
    expect(
      (await createPOST(jsonReq({ url: "https://x.example", name: "n", events: ["flow.started"] }, { authorization: `Bearer ${raw}` }))).status
    ).toBe(403);
  });

  it("a non-admin member cannot manage webhooks (403)", async () => {
    session.client = member.client;
    cookie.workspaceId = ownerA.workspaceId;
    expect((await listGET(plainReq())).status).toBe(403);
    expect((await createPOST(jsonReq({ url: "https://x.example", name: "n", events: ["flow.started"] }))).status).toBe(403);
  });

  it("cannot update or delete another workspace's endpoint (404)", async () => {
    const foreign = await makeEndpoint(ownerB.workspaceId, { events: ["flow.started"] });
    asAdminA();
    expect((await updatePUT(jsonReq({ is_active: false }), params(foreign))).status).toBe(404);
    expect((await deleteDELETE(plainReq(), params(foreign))).status).toBe(404);
  });

  it("clears the secret when secret:null (deliveries become unsigned)", async () => {
    const id = await makeEndpoint(ownerA.workspaceId, { events: ["flow.started"], secret: "s" });
    asAdminA();
    const res = await updatePUT(jsonReq({ secret: null }), params(id));
    expect(res.status).toBe(200);
    const { data: row } = await serviceClient()
      .from("webhook_endpoints")
      .select("secret_encrypted")
      .eq("id", id)
      .single();
    expect(row!.secret_encrypted).toBeNull();
  });

  it("re-enabling an endpoint resets its failure_count", async () => {
    const id = await makeEndpoint(ownerA.workspaceId, { events: ["flow.started"], isActive: false, failureCount: 7 });
    asAdminA();
    const res = await updatePUT(jsonReq({ is_active: true }), params(id));
    expect(res.status).toBe(200);
    expect((await res.json()).data.failure_count).toBe(0);
  });
});

describe("dispatchWebhookEvent — delivery", () => {
  it("signs the payload with HMAC-SHA256 (X-Zernflow-Signature) and resets failures on 2xx", async () => {
    const id = await makeEndpoint(ownerA.workspaceId, {
      url: "https://hook.example.com/sign",
      events: ["flow.started"],
      secret: "topsecret",
      failureCount: 5,
    });

    await dispatchWebhookEvent(ownerA.workspaceId, "flow.started", { flowId: "f1" });

    expect(sf.calls).toHaveLength(1);
    const call = sf.calls[0];
    expect(call.url).toBe("https://hook.example.com/sign");
    expect(call.headers["User-Agent"]).toBe("Zernflow-Webhook/1.0");
    expect(call.headers["X-Zernflow-Signature"]).toBe(
      createHmac("sha256", "topsecret").update(call.body).digest("hex")
    );
    const payload = JSON.parse(call.body);
    expect(payload.event).toBe("flow.started");
    expect(payload.data).toEqual({ flowId: "f1" });

    const { data: row } = await serviceClient()
      .from("webhook_endpoints")
      .select("failure_count, last_triggered_at")
      .eq("id", id)
      .single();
    expect(row!.failure_count).toBe(0);
    expect(row!.last_triggered_at).not.toBeNull();
  });

  it("omits the signature header when the endpoint has no secret", async () => {
    await makeEndpoint(ownerA.workspaceId, { events: ["flow.started"] }); // no secret
    await dispatchWebhookEvent(ownerA.workspaceId, "flow.started", {});
    expect(sf.calls).toHaveLength(1);
    expect(sf.calls[0].headers).not.toHaveProperty("X-Zernflow-Signature");
  });

  it("increments failure_count on a non-2xx and auto-disables at 10", async () => {
    const id = await makeEndpoint(ownerA.workspaceId, { events: ["flow.started"], secret: "s", failureCount: 9 });
    sf.status = 500;
    await dispatchWebhookEvent(ownerA.workspaceId, "flow.started", {});
    const { data: row } = await serviceClient()
      .from("webhook_endpoints")
      .select("failure_count, is_active")
      .eq("id", id)
      .single();
    expect(row!.failure_count).toBe(10);
    expect(row!.is_active).toBe(false);
  });

  it("counts an SSRF-blocked URL as a failed delivery", async () => {
    const id = await makeEndpoint(ownerA.workspaceId, { events: ["flow.started"], failureCount: 0 });
    sf.throwKind = "ssrf";
    await dispatchWebhookEvent(ownerA.workspaceId, "flow.started", {});
    const { data: row } = await serviceClient()
      .from("webhook_endpoints")
      .select("failure_count")
      .eq("id", id)
      .single();
    expect(row!.failure_count).toBe(1);
  });

  it("only delivers to endpoints subscribed to the event", async () => {
    await makeEndpoint(ownerA.workspaceId, { events: ["message.sent"] });
    await dispatchWebhookEvent(ownerA.workspaceId, "flow.started", {});
    expect(sf.calls).toHaveLength(0);
  });

  it("skips inactive endpoints", async () => {
    await makeEndpoint(ownerA.workspaceId, { events: ["flow.started"], isActive: false });
    await dispatchWebhookEvent(ownerA.workspaceId, "flow.started", {});
    expect(sf.calls).toHaveLength(0);
  });

  it("never delivers another workspace's events (tenant isolation)", async () => {
    await makeEndpoint(ownerB.workspaceId, { url: "https://b.example/in", events: ["flow.started"] });
    await dispatchWebhookEvent(ownerA.workspaceId, "flow.started", {});
    expect(sf.calls).toHaveLength(0);
  });
});

describe("/api/v1/webhook-endpoints/:id/test", () => {
  it("delivers a signed test event and reports the status", async () => {
    const id = await makeEndpoint(ownerA.workspaceId, { events: ["flow.started"], secret: "s" });
    asAdminA();
    const res = await testPOST(plainReq(), params(id));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.statusCode).toBe(200);
    expect(sf.calls).toHaveLength(1);
    expect(JSON.parse(sf.calls[0].body).event).toBe("test");
    expect(sf.calls[0].headers["X-Zernflow-Signature"]).toBe(
      createHmac("sha256", "s").update(sf.calls[0].body).digest("hex")
    );
  });

  it("returns 404 for another workspace's endpoint", async () => {
    const foreign = await makeEndpoint(ownerB.workspaceId, { events: ["flow.started"] });
    asAdminA();
    expect((await testPOST(plainReq(), params(foreign))).status).toBe(404);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { anonClient, serviceClient, createTestUser } from "./helpers";

// Seam: swap the Supabase client factory only — RLS and the DB stay real.
let currentClient: SupabaseClient<Database> | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));

// Controllable cookie store so we can drive active_profile_id resolution.
let cookieJar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in cookieJar ? { value: cookieJar[name] } : undefined,
  }),
}));

import { authenticateRequest } from "@/lib/api-auth";

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/_", { headers });
}

function newKey() {
  const raw = `zf_${crypto.randomBytes(16).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 8) };
}

beforeEach(() => {
  currentClient = null;
  cookieJar = {};
});

// Give an existing user a SECOND workspace bound to a distinct Zernio profile,
// so cookie-driven active-workspace resolution is actually discriminating
// (a single-workspace user can't prove the cookie changed anything).
async function addSecondWorkspace(userId: string, ownWorkspaceId: string) {
  const svc = serviceClient();
  const p1 = `prof-${crypto.randomUUID()}`;
  const p2 = `prof-${crypto.randomUUID()}`;
  await svc.from("workspaces").update({ zernio_profile_id: p1 }).eq("id", ownWorkspaceId);
  const { data: ws2 } = await svc
    .from("workspaces")
    .insert({ name: "Client Two", slug: `ws2-${crypto.randomUUID().slice(0, 8)}`, zernio_profile_id: p2 })
    .select("id")
    .single();
  await svc.from("workspace_members").insert({ workspace_id: ws2!.id, user_id: userId, role: "owner" });
  return { p1, p2, ws2Id: ws2!.id };
}

describe("authenticateRequest — session", () => {
  it("resolves the caller's workspace and identity", async () => {
    const owner = await createTestUser("auth-session");
    currentClient = owner.client;

    const result = await authenticateRequest(req());

    expect(result).not.toBeNull();
    expect(result!.authMethod).toBe("session");
    expect(result!.workspaceId).toBe(owner.workspaceId);
    expect(result!.userId).toBe(owner.userId);
  });

  it("honors active_profile_id to select the RIGHT workspace among several (agency multi-client)", async () => {
    const owner = await createTestUser("auth-active");
    currentClient = owner.client;
    const { p2, ws2Id } = await addSecondWorkspace(owner.userId, owner.workspaceId);

    cookieJar["active_profile_id"] = p2; // select the second client

    const result = await authenticateRequest(req());
    // Must be the cookie-selected workspace — NOT an arbitrary/first membership.
    // (Upstream's .limit(1).single() would ignore the cookie and fail this.)
    expect(result!.workspaceId).toBe(ws2Id);
  });

  it("a forged active_profile_id (a profile the caller doesn't own) cannot escalate", async () => {
    const owner = await createTestUser("auth-escalate");
    currentClient = owner.client;
    const { ws2Id } = await addSecondWorkspace(owner.userId, owner.workspaceId);

    cookieJar["active_profile_id"] = `prof-foreign-${crypto.randomUUID()}`;

    const result = await authenticateRequest(req());
    // resolveWorkspaceId only matches the caller's OWN memberships → falls back to
    // one of THEIR workspaces, never a foreign one.
    expect([owner.workspaceId, ws2Id]).toContain(result!.workspaceId);
  });

  it("returns null when there is no session", async () => {
    currentClient = anonClient(); // anonymous: no user
    expect(await authenticateRequest(req())).toBeNull();
  });
});

describe("authenticateRequest — API key", () => {
  it("resolves the key's workspace (no user identity)", async () => {
    const owner = await createTestUser("auth-key");
    const k = newKey();
    await serviceClient()
      .from("api_keys")
      .insert({
        workspace_id: owner.workspaceId,
        name: "test key",
        key_hash: k.hash,
        key_prefix: k.prefix,
      });

    const result = await authenticateRequest(
      req({ authorization: `Bearer ${k.raw}` })
    );

    expect(result).not.toBeNull();
    expect(result!.authMethod).toBe("api_key");
    expect(result!.workspaceId).toBe(owner.workspaceId);
    expect(result!.userId).toBeNull();
  });

  it("a key only ever yields its OWN workspace, never another tenant's", async () => {
    const a = await createTestUser("auth-tenantA");
    const b = await createTestUser("auth-tenantB");
    const k = newKey();
    await serviceClient()
      .from("api_keys")
      .insert({
        workspace_id: a.workspaceId,
        name: "tenant A key",
        key_hash: k.hash,
        key_prefix: k.prefix,
      });

    const result = await authenticateRequest(
      req({ authorization: `Bearer ${k.raw}` })
    );

    expect(result!.workspaceId).toBe(a.workspaceId);
    expect(result!.workspaceId).not.toBe(b.workspaceId);
  });

  it("returns null for an unknown key", async () => {
    expect(
      await authenticateRequest(
        req({ authorization: "Bearer zf_deadbeefdeadbeefdeadbeefdeadbeef" })
      )
    ).toBeNull();
  });
});

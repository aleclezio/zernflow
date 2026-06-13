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

  it("a forged active_profile_id cookie cannot escalate to a foreign workspace", async () => {
    const owner = await createTestUser("auth-escalate");
    currentClient = owner.client;
    cookieJar["active_profile_id"] = "a-different-tenants-profile-id";

    const result = await authenticateRequest(req());

    // resolveWorkspaceId only matches among the caller's OWN memberships, so the
    // forged cookie is ignored and we fall back to the caller's own workspace.
    expect(result!.workspaceId).toBe(owner.workspaceId);
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

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { resolveWorkspaceId } from "@/lib/workspace-resolve";
import { PROFILE_COOKIE, WORKSPACE_COOKIE } from "@/lib/workspace";
import { checkRateLimit } from "@/lib/rate-limit";
import { isApiKeyExpired } from "@/lib/api-key";

export interface AuthResult {
  workspaceId: string;
  userId: string | null; // null for API-key auth (no user identity)
  authMethod: "session" | "api_key";
}

// Per-workspace API-key request budget. In-memory + single-node (see lib/rate-limit.ts).
const API_KEY_RATE_LIMIT = 120;
const API_KEY_RATE_WINDOW_MS = 60_000;

/**
 * Authenticate a /api/v1 request via Supabase session cookie OR an API key.
 * Returns the caller's workspace + method, or null if unauthenticated.
 *
 * API keys: `Bearer zf_<hex>`, SHA-256 hashed and matched against api_keys.key_hash.
 *
 * Session auth resolves the ACTIVE workspace via the active_profile_id cookie (the
 * command-centre client switcher) — NOT an arbitrary first membership — so an operator
 * with many client workspaces is scoped to the one they selected. resolveWorkspaceId
 * only matches among the caller's OWN memberships, so a forged active_profile_id cookie
 * cannot escalate to a workspace the caller doesn't belong to (it falls back to their own).
 */
export async function authenticateRequest(request: NextRequest): Promise<AuthResult | null> {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer zf_")) {
    return authenticateApiKey(authHeader.slice("Bearer ".length));
  }
  return authenticateSession();
}

async function authenticateSession(): Promise<AuthResult | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspace_id, workspaces(zernio_profile_id)")
    .eq("user_id", user.id);

  const accessible = (memberships ?? []).filter((m) => m.workspaces);
  if (accessible.length === 0) return null;

  const cookieStore = await cookies();
  const resolvedId = resolveWorkspaceId(
    accessible.map((m) => ({
      workspace_id: m.workspace_id,
      zernio_profile_id: m.workspaces!.zernio_profile_id,
    })),
    {
      activeProfileId: cookieStore.get(PROFILE_COOKIE)?.value,
      workspaceId: cookieStore.get(WORKSPACE_COOKIE)?.value,
    },
  );

  return {
    workspaceId: resolvedId ?? accessible[0].workspace_id,
    userId: user.id,
    authMethod: "session",
  };
}

async function authenticateApiKey(apiKey: string): Promise<AuthResult | null> {
  if (!apiKey.startsWith("zf_")) return null;

  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const supabase = await createServiceClient();

  const { data: key } = await supabase
    .from("api_keys")
    .select("workspace_id, expires_at")
    .eq("key_hash", hash)
    .maybeSingle();

  if (!key) return null;
  if (isApiKeyExpired(key.expires_at, Date.now())) return null;

  // Best-effort last-used stamp; never blocks or fails the request.
  void supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", hash)
    .then(
      () => {},
      () => {}
    );

  return {
    workspaceId: key.workspace_id,
    userId: null,
    authMethod: "api_key",
  };
}

export type ApiV1Authorized = {
  ok: true;
  auth: AuthResult;
  supabase: SupabaseClient<Database>;
};
export type ApiV1Rejected = { ok: false; response: NextResponse };

/**
 * One-stop guard for /api/v1 endpoints. Authenticates (session or API key),
 * rate-limits API-key traffic (429), and returns the correctly-scoped Supabase
 * client: the SERVICE client for API-key auth (no session → RLS keys off a null
 * auth.uid(), so the session client would return zero rows), the session client
 * otherwise. API-key requests therefore rely on each endpoint's own explicit
 * .eq("workspace_id", auth.workspaceId) scoping, since the service client
 * bypasses RLS.
 */
export async function authorizeApiV1(
  request: NextRequest
): Promise<ApiV1Authorized | ApiV1Rejected> {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (auth.authMethod === "api_key") {
    const allowed = checkRateLimit(
      `apiv1:${auth.workspaceId}`,
      API_KEY_RATE_LIMIT,
      API_KEY_RATE_WINDOW_MS
    );
    if (!allowed) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }),
      };
    }
  }
  const supabase =
    auth.authMethod === "api_key" ? await createServiceClient() : await createClient();
  return { ok: true, auth, supabase };
}

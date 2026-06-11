import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createZernioClient } from "@/lib/zernio-client";
import { setZernioKey } from "@/lib/workspace-keys";
import { checkRateLimit } from "@/lib/rate-limit";
import { accountProfileId } from "@/lib/zernio-scope";
import { registerWorkspaceWebhook } from "@/lib/webhook-registration";
import { logSecurityEvent } from "@/lib/security-events";

/**
 * POST /api/v1/channels/test-key
 *
 * Validates a Zernio API key, binds the workspace to ONE Zernio profile,
 * saves the key (encrypted at rest, AAD = workspace id), and syncs the
 * bound profile's channels.
 *
 * Binding rules (never guess):
 * - workspace already bound  -> the key must see that profile, else 409
 * - unbound + key sees 1     -> auto-bind it
 * - unbound + key sees many  -> 422 with the list; caller retries with
 *                               an explicit profileId
 *
 * Requires: authenticated user, OWNER of the target workspace. Rate limited
 * per user — this endpoint must not be a key-validation oracle.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!checkRateLimit(`test-key:${user.id}`, 5, 60_000)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => null);
  const apiKey = body?.apiKey;
  const workspaceId = body?.workspaceId;
  const requestedProfileId = body?.profileId;

  if (!apiKey || typeof apiKey !== "string" || !workspaceId || typeof workspaceId !== "string") {
    return NextResponse.json(
      { error: "apiKey and workspaceId are required" },
      { status: 400 }
    );
  }

  // Owner-only: members must not be able to swap the workspace key.
  // A transient lookup error must NOT read as "not a member" — fail 503.
  const { data: membership, error: membershipErr } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipErr) {
    return NextResponse.json({ error: "Temporary error, retry" }, { status: 503 });
  }
  if (!membership || membership.role !== "owner") {
    return NextResponse.json(
      { error: "Only the workspace owner can manage API keys" },
      { status: 403 }
    );
  }

  const { data: wsRow } = await supabase
    .from("workspaces")
    .select("zernio_profile_id")
    .eq("id", workspaceId)
    .maybeSingle();
  const boundProfileId = wsRow?.zernio_profile_id ?? null;

  const zernio = createZernioClient(apiKey.trim());

  // SDK errors are never echoed — they can embed request/auth details.
  let profiles: Array<{ _id?: string; name?: string }>;
  try {
    const res = await zernio.profiles.listProfiles();
    profiles = res.data?.profiles ?? [];
  } catch {
    await logSecurityEvent("test_key_rejected", workspaceId, { reason: "sdk_error" });
    return NextResponse.json(
      { error: "Invalid API key or connection error" },
      { status: 400 }
    );
  }

  // Resolve the target profile — never guess between several.
  let targetProfile: { _id?: string; name?: string } | undefined;
  if (boundProfileId) {
    targetProfile = profiles.find((p) => p._id === boundProfileId);
    if (!targetProfile) {
      return NextResponse.json(
        {
          code: "PROFILE_MISMATCH",
          error:
            "This key cannot access the Zernio profile bound to this workspace. Use a key scoped to the bound profile.",
        },
        { status: 409 }
      );
    }
  } else if (requestedProfileId && typeof requestedProfileId === "string") {
    targetProfile = profiles.find((p) => p._id === requestedProfileId);
    if (!targetProfile) {
      return NextResponse.json(
        {
          code: "PROFILE_CHOICE_REQUIRED",
          error: "The chosen profile is not accessible with this key.",
          profiles: profiles.map((p) => ({ id: p._id, name: p.name })),
        },
        { status: 422 }
      );
    }
  } else if (profiles.length === 1) {
    targetProfile = profiles[0];
  } else if (profiles.length === 0) {
    return NextResponse.json(
      { error: "This key sees no Zernio profiles. Create one in your Zernio dashboard first." },
      { status: 400 }
    );
  } else {
    return NextResponse.json(
      {
        code: "PROFILE_CHOICE_REQUIRED",
        error: "This key can access several Zernio profiles. Choose which one to bind to this workspace.",
        profiles: profiles.map((p) => ({ id: p._id, name: p.name })),
      },
      { status: 422 }
    );
  }

  const profileId = targetProfile._id!;
  const warning =
    profiles.length > 1
      ? `This key can access ${profiles.length} Zernio profiles. For real client isolation, create a key scoped to only this profile in the Zernio dashboard.`
      : undefined;

  // Validate the key against the bound profile's accounts.
  let accounts: Array<{
    _id?: string;
    platform?: string;
    username?: string;
    displayName?: string;
    profilePicture?: string;
    profileId?: string | { _id?: string };
  }>;
  try {
    const res = await zernio.accounts.listAccounts({ query: { profileId } });
    accounts = (res.data?.accounts ?? []) as typeof accounts;
  } catch {
    return NextResponse.json(
      { error: "Invalid API key or connection error" },
      { status: 400 }
    );
  }

  // Defensive post-filter (same invariant as channels/sync).
  const scoped = accounts.filter((a) => accountProfileId(a) === profileId);
  if (scoped.length !== accounts.length) {
    console.error(
      `[anomaly] test-key: Zernio returned ${accounts.length - scoped.length} account(s) outside the target profile (workspace ${workspaceId})`
    );
  }

  // Bind profile first (unique index makes profile<->workspace 1:1).
  if (!boundProfileId) {
    const { error: bindErr } = await supabase
      .from("workspaces")
      .update({
        zernio_profile_id: profileId,
        zernio_profile_name: targetProfile.name ?? null,
      })
      .eq("id", workspaceId)
      .select("id")
      .single();

    if (bindErr) {
      if (bindErr.code === "23505") {
        return NextResponse.json(
          {
            code: "PROFILE_ALREADY_BOUND",
            error: "This Zernio profile is already bound to another workspace.",
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Failed to bind profile" }, { status: 500 });
    }
  }

  const { error: saveErr } = await setZernioKey(supabase, workspaceId, apiKey.trim());
  if (saveErr) {
    return NextResponse.json(
      { error: "Key valid but failed to save" },
      { status: 500 }
    );
  }

  await logSecurityEvent("key_saved", workspaceId, { profileId });

  // Register/refresh the per-workspace webhook. Non-fatal: scoped keys may
  // not manage webhooks (operator fallback: scripts/register-webhook.mjs).
  const registration = await registerWorkspaceWebhook(supabase, workspaceId, apiKey.trim());

  // Auto-sync the bound profile's channels.
  const { data: existingChannels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspaceId);

  const existingByLateId = new Map(
    (existingChannels ?? []).map((c) => [c.late_account_id, c])
  );

  // Channel INSERT is service-role only (tenant lockdown): these accounts
  // were just verified against the key and the bound profile.
  const serviceDb = await createServiceClient();
  for (const account of scoped) {
    if (!account._id) continue;
    if (existingByLateId.has(account._id)) continue;

    await serviceDb.from("channels").insert({
      workspace_id: workspaceId,
      platform: account.platform as "facebook" | "instagram" | "twitter" | "telegram" | "bluesky" | "reddit",
      late_account_id: account._id,
      username: account.username || null,
      display_name: account.displayName || account.username || null,
      profile_picture: account.profilePicture || null,
      is_active: true,
    });
  }

  return NextResponse.json({
    accounts: scoped,
    profile: { id: profileId, name: targetProfile.name ?? null },
    ...(warning ? { warning } : {}),
    ...(registration.ok ? {} : { webhookWarning: registration.warning }),
  });
}

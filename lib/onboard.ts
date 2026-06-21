/**
 * Client onboarding engine — the ONE source of truth for standing up a full
 * ZernFlow tenant. Collapses the five previously-manual steps (create
 * workspace + owner membership, bind a Zernio profile + sync channels, add the
 * operator membership, issue a scoped API key, register the inbound webhook)
 * into one idempotent call.
 *
 * Exposed two ways, both thin wrappers over THIS function so they never
 * diverge:
 *   - app/api/admin/onboard-client/route.ts  (admin-token gated HTTP route)
 *   - scripts/onboard-client.mjs             (operator CLI -> the route)
 *   - command-centre "Add client" button     (dashboard -> the route)
 *
 * Runs with the service-role client (no user session). The 00013 tenant-lockdown
 * guard explicitly permits service-role writes to the profile/webhook columns
 * (auth.uid() is null for trusted server code), so binding succeeds here.
 *
 * Secrets: the client's Zernio key and any admin key are passed in by the
 * caller and are NEVER logged. The issued scoped key is returned exactly once.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { createServiceClient } from "@/lib/supabase/server";
import { createZernioClient } from "@/lib/zernio-client";
import { setZernioKey } from "@/lib/workspace-keys";
import { accountProfileId } from "@/lib/zernio-scope";
import { registerWorkspaceWebhook } from "@/lib/webhook-registration";
import { generateApiKey, hashApiKey, keyPrefix, parseScopes, type ApiScope } from "@/lib/api-key";

type Platform = "facebook" | "instagram" | "twitter" | "telegram" | "bluesky" | "reddit";

export interface OnboardClientInput {
  /** Workspace display name (e.g. the client's brand). */
  name: string;
  /** Explicit slug; derived from `name` when omitted. Must be globally unique. */
  slug?: string;
  /** Existing auth.users id that owns the workspace (gets the 'owner' membership). */
  ownerUserId: string;
  /** The client's (ideally profile-scoped) Zernio API key — stored encrypted. */
  zernioApiKey: string;
  /** Zernio profile to bind. Required when the key can see more than one profile. */
  profileId?: string;
  /** Agency operator added as an 'operator' member so they can switch in. Skipped when equal to the owner. */
  operatorUserId?: string;
  /** Name for the issued ZernFlow API key (default 'onboarding'). Re-runs with the same name don't re-issue. */
  keyName?: string;
  /** Scopes for the issued key (default ['read'] — least privilege). */
  keyScopes?: ApiScope[];
  /** Public app base URL for the inbound webhook (default NEXT_PUBLIC_APP_URL), e.g. https://os.lygge.com/engage. */
  appUrl?: string;
  /** Key used to REGISTER the webhook (an admin key is preferred; scoped keys often can't). Defaults to zernioApiKey. */
  webhookZernioKey?: string;
}

export interface OnboardClientResult {
  workspaceId: string;
  workspaceCreated: boolean;
  slug: string;
  profile: { id: string; name: string | null; bound: "created" | "existing" };
  channelsSynced: number;
  ownerMembership: "created" | "existing";
  operatorMembership: "added" | "existing" | "skipped";
  apiKey: { issued: boolean; name: string; scopes: ApiScope[]; key?: string; keyId?: string };
  webhook: { ok: boolean; warning?: string };
}

/** A step-level onboarding failure. `code` mirrors the test-key route codes where applicable. */
export class OnboardError extends Error {
  constructor(
    public step: string,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "OnboardError";
  }
}

/** Slug from a name: lowercase, non-alphanumerics to single hyphens, trimmed. */
export function deriveSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function onboardClient(
  input: OnboardClientInput,
  db?: SupabaseClient<Database>
): Promise<OnboardClientResult> {
  const serviceDb = db ?? (await createServiceClient());

  const name = input.name?.trim();
  if (!name) throw new OnboardError("workspace", "name is required");
  if (!input.ownerUserId) throw new OnboardError("workspace", "ownerUserId is required");
  if (!input.zernioApiKey?.trim()) throw new OnboardError("bind", "zernioApiKey is required");

  const slug = (input.slug?.trim() || deriveSlug(name)) || deriveSlug("workspace");

  // ── Step 1: workspace + owner membership (idempotent by slug) ───────────────
  let workspaceId: string;
  let workspaceCreated = false;
  const { data: existingWs } = await serviceDb
    .from("workspaces")
    .select("id, zernio_profile_id, zernio_profile_name")
    .eq("slug", slug)
    .maybeSingle();

  if (existingWs) {
    workspaceId = existingWs.id;
  } else {
    const { data: inserted, error: wsErr } = await serviceDb
      .from("workspaces")
      .insert({ name, slug })
      .select("id")
      .single();
    if (wsErr) {
      if (wsErr.code === "23505") {
        // Lost a create race on the unique slug — adopt the existing row.
        const { data: refetched, error: refErr } = await serviceDb
          .from("workspaces")
          .select("id")
          .eq("slug", slug)
          .single();
        if (refErr || !refetched) throw new OnboardError("workspace", refErr?.message ?? "slug race");
        workspaceId = refetched.id;
      } else {
        throw new OnboardError("workspace", wsErr.message);
      }
    } else {
      workspaceId = inserted.id;
      workspaceCreated = true;
    }
  }

  const ownerMembership = await ensureMembership(serviceDb, workspaceId, input.ownerUserId, "owner");

  // ── Step 2: bind Zernio profile + sync channels ─────────────────────────────
  const apiKey = input.zernioApiKey.trim();
  const zernio = createZernioClient(apiKey);

  let profiles: Array<{ _id?: string; name?: string }>;
  try {
    const res = await zernio.profiles.listProfiles();
    profiles = res.data?.profiles ?? [];
  } catch {
    // Never echo SDK errors — they can embed auth detail.
    throw new OnboardError("bind", "Invalid Zernio API key or connection error");
  }

  const { data: boundRow } = await serviceDb
    .from("workspaces")
    .select("zernio_profile_id")
    .eq("id", workspaceId)
    .maybeSingle();
  const boundProfileId = boundRow?.zernio_profile_id ?? null;

  let targetProfile: { _id?: string; name?: string } | undefined;
  if (boundProfileId) {
    targetProfile = profiles.find((p) => p._id === boundProfileId);
    if (!targetProfile) {
      throw new OnboardError(
        "bind",
        "This key cannot access the Zernio profile already bound to this workspace.",
        "PROFILE_MISMATCH"
      );
    }
  } else if (input.profileId) {
    targetProfile = profiles.find((p) => p._id === input.profileId);
    if (!targetProfile) {
      throw new OnboardError("bind", "The requested profileId is not accessible with this key.", "PROFILE_CHOICE_REQUIRED");
    }
  } else if (profiles.length === 1) {
    targetProfile = profiles[0];
  } else if (profiles.length === 0) {
    throw new OnboardError("bind", "This key sees no Zernio profiles. Create one in Zernio first.");
  } else {
    throw new OnboardError(
      "bind",
      `This key can access ${profiles.length} Zernio profiles. Pass profileId to choose one.`,
      "PROFILE_CHOICE_REQUIRED"
    );
  }

  const profileId = targetProfile._id!;
  const profileName = targetProfile.name ?? null;

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
    throw new OnboardError("bind", "Invalid Zernio API key or connection error");
  }

  // Defensive: never sync an account outside the bound profile (same invariant
  // as channels/sync + test-key).
  const scoped = accounts.filter((a) => accountProfileId(a) === profileId);

  let profileBound: "created" | "existing" = "existing";
  if (!boundProfileId) {
    const { error: bindErr } = await serviceDb
      .from("workspaces")
      .update({ zernio_profile_id: profileId, zernio_profile_name: profileName })
      .eq("id", workspaceId)
      .select("id")
      .single();
    if (bindErr) {
      if (bindErr.code === "23505") {
        throw new OnboardError("bind", "This Zernio profile is already bound to another workspace.", "PROFILE_ALREADY_BOUND");
      }
      throw new OnboardError("bind", bindErr.message);
    }
    profileBound = "created";
  }

  const { error: keySaveErr } = await setZernioKey(serviceDb, workspaceId, apiKey);
  if (keySaveErr) throw new OnboardError("bind", "Zernio key valid but failed to save");

  // Sync the bound profile's accounts as channels (insert missing only).
  const { data: existingChannels } = await serviceDb
    .from("channels")
    .select("late_account_id")
    .eq("workspace_id", workspaceId);
  const existingByLateId = new Set((existingChannels ?? []).map((c) => c.late_account_id));

  let channelsSynced = 0;
  for (const account of scoped) {
    if (!account._id || existingByLateId.has(account._id)) continue;
    const { error: chErr } = await serviceDb.from("channels").insert({
      workspace_id: workspaceId,
      platform: account.platform as Platform,
      late_account_id: account._id,
      username: account.username || null,
      display_name: account.displayName || account.username || null,
      profile_picture: account.profilePicture || null,
      is_active: true,
    });
    if (!chErr) channelsSynced++;
  }

  // ── Step 3: operator membership ─────────────────────────────────────────────
  let operatorMembership: OnboardClientResult["operatorMembership"] = "skipped";
  if (input.operatorUserId && input.operatorUserId !== input.ownerUserId) {
    const m = await ensureMembership(serviceDb, workspaceId, input.operatorUserId, "operator");
    operatorMembership = m === "created" ? "added" : "existing";
  }

  // ── Step 4: issue a scoped API key (idempotent by name) ─────────────────────
  const keyNameRaw = input.keyName?.trim() || "onboarding";
  let keyScopes: ApiScope[] = ["read"];
  if (input.keyScopes !== undefined) {
    const parsed = parseScopes(input.keyScopes);
    if (!parsed) throw new OnboardError("api_key", "keyScopes must be a non-empty subset of read, write, send");
    keyScopes = parsed;
  }

  const { data: existingKey } = await serviceDb
    .from("api_keys")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("name", keyNameRaw)
    .maybeSingle();

  let apiKeyResult: OnboardClientResult["apiKey"];
  if (existingKey) {
    // A key with this name already exists; the raw secret can never be re-shown.
    apiKeyResult = { issued: false, name: keyNameRaw, scopes: keyScopes, keyId: existingKey.id };
  } else {
    const raw = generateApiKey();
    const { data: keyRow, error: keyErr } = await serviceDb
      .from("api_keys")
      .insert({
        workspace_id: workspaceId,
        name: keyNameRaw,
        key_hash: hashApiKey(raw),
        key_prefix: keyPrefix(raw),
        scopes: keyScopes,
        created_by: input.operatorUserId ?? input.ownerUserId,
      })
      .select("id")
      .single();
    if (keyErr || !keyRow) throw new OnboardError("api_key", "Failed to issue API key");
    apiKeyResult = { issued: true, name: keyNameRaw, scopes: keyScopes, key: raw, keyId: keyRow.id };
  }

  // ── Step 5: register the inbound webhook ────────────────────────────────────
  const appUrl = input.appUrl?.replace(/\/$/, "") || process.env.NEXT_PUBLIC_APP_URL;
  const webhookKey = input.webhookZernioKey?.trim() || apiKey;
  const webhook = await registerWorkspaceWebhook(serviceDb, workspaceId, webhookKey, { appUrl });

  return {
    workspaceId,
    workspaceCreated,
    slug,
    profile: { id: profileId, name: profileName, bound: profileBound },
    channelsSynced,
    ownerMembership,
    operatorMembership,
    apiKey: apiKeyResult,
    webhook,
  };
}

/** Insert a membership; an existing (workspace_id, user_id) row is left as-is. */
async function ensureMembership(
  serviceDb: SupabaseClient<Database>,
  workspaceId: string,
  userId: string,
  role: "owner" | "operator"
): Promise<"created" | "existing"> {
  const { error } = await serviceDb
    .from("workspace_members")
    .insert({ workspace_id: workspaceId, user_id: userId, role });
  if (!error) return "created";
  if (error.code === "23505") return "existing"; // PK (workspace_id, user_id) already present
  throw new OnboardError(role === "owner" ? "owner_membership" : "operator_membership", error.message);
}

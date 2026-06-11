/**
 * Single accessor for per-workspace secrets. Every read of the key columns
 * (late_api_key_encrypted, ai_api_key) MUST go through this module — enforced
 * by scripts/check-key-access.sh in CI.
 *
 * Fail-closed semantics: values that are not enc:v1 ciphertext (legacy
 * plaintext from upstream installs) are treated as NOT CONFIGURED. They are
 * never passed to the SDK and never returned to callers; the user re-enters
 * the key in Settings, which stores it encrypted.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { decryptSecret, encryptSecret, isEncrypted } from "@/lib/crypto";

type KeyColumn = "late_api_key_encrypted" | "ai_api_key";

async function getKey(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  column: KeyColumn
): Promise<string | null> {
  const { data } = await supabase
    .from("workspaces")
    .select(column)
    .eq("id", workspaceId)
    .maybeSingle();

  const stored = (data as Record<string, string | null> | null)?.[column] ?? null;
  if (!stored || !isEncrypted(stored)) return null;

  try {
    return decryptSecret(stored, workspaceId);
  } catch {
    // Wrong AAD / tampered / key rotated without migration: fail closed.
    console.error(`workspace-keys: failed to decrypt ${column} for workspace ${workspaceId}`);
    return null;
  }
}

/** Decrypted Zernio API key for the workspace, or null if not configured. */
export function getZernioKey(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<string | null> {
  return getKey(supabase, workspaceId, "late_api_key_encrypted");
}

/** Decrypted AI gateway key for the workspace, or null if not configured. */
export function getAiKey(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<string | null> {
  return getKey(supabase, workspaceId, "ai_api_key");
}

/** Encrypt (AAD = workspace id) and store a secret on the workspace row. */
async function setWorkspaceSecret(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  column: KeyColumn,
  plaintext: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("workspaces")
    .update({ [column]: encryptSecret(plaintext, workspaceId) })
    .eq("id", workspaceId)
    .select("id")
    .single();
  return { error: error ? error.message : null };
}

/** Encrypt and store the workspace's Zernio API key. */
export function setZernioKey(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  plaintext: string
): Promise<{ error: string | null }> {
  return setWorkspaceSecret(supabase, workspaceId, "late_api_key_encrypted", plaintext);
}

/** Encrypt and store the workspace's AI gateway key. */
export function setAiKey(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  plaintext: string
): Promise<{ error: string | null }> {
  return setWorkspaceSecret(supabase, workspaceId, "ai_api_key", plaintext);
}

/**
 * Resolve a webhook capability-URL token (by its sha256 hash) to the owning
 * workspace and its decrypted webhook secret. The secret is MANDATORY for
 * processing — callers must 401 when it is null.
 */
export async function findWorkspaceByWebhookToken(
  supabase: SupabaseClient<Database>,
  tokenHash: string
): Promise<{ workspaceId: string; webhookSecret: string | null } | null> {
  const { data } = await supabase
    .from("workspaces")
    .select("id, webhook_secret_encrypted")
    .eq("webhook_token_hash", tokenHash)
    .maybeSingle();

  if (!data) return null;

  let webhookSecret: string | null = null;
  if (data.webhook_secret_encrypted && isEncrypted(data.webhook_secret_encrypted)) {
    try {
      webhookSecret = decryptSecret(data.webhook_secret_encrypted, data.id);
    } catch {
      console.error(`workspace-keys: failed to decrypt webhook secret for workspace ${data.id}`);
    }
  }
  return { workspaceId: data.id, webhookSecret };
}

/** Store webhook registration credentials (secret encrypted, token hashed). */
export async function setWebhookCredentials(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  creds: { tokenHash: string; secret: string; zernioWebhookId: string | null }
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("workspaces")
    .update({
      webhook_token_hash: creds.tokenHash,
      webhook_secret_encrypted: encryptSecret(creds.secret, workspaceId),
      zernio_webhook_id: creds.zernioWebhookId,
    })
    .eq("id", workspaceId)
    .select("id")
    .single();
  return { error: error ? error.message : null };
}

/**
 * Configured-or-not flags for UI display. Legacy plaintext counts as NOT
 * configured so the UI prompts re-entry.
 */
export function workspaceKeyStatus(row: {
  late_api_key_encrypted: string | null;
  ai_api_key: string | null;
}): { hasApiKey: boolean; hasAiKey: boolean } {
  return {
    hasApiKey: isEncrypted(row.late_api_key_encrypted),
    hasAiKey: isEncrypted(row.ai_api_key),
  };
}

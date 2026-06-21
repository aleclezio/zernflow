/**
 * Webhook registration: one webhook per workspace, registered with the
 * workspace's own (profile-scoped) key on key save.
 *
 * The URL embeds a 32-byte capability token; we store only its sha256 hash.
 * The HMAC secret is generated here, sent to Zernio, and stored encrypted
 * (AAD = workspace id).
 *
 * Failure is NON-FATAL by design: scoped keys may not be allowed to manage
 * webhooks (verified live in V4), and localhost URLs can't receive
 * deliveries. Callers surface the warning; scripts/register-webhook.mjs is
 * the operator fallback using the master key.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { createZernioClient } from "@/lib/zernio-client";
import { setWebhookCredentials } from "@/lib/workspace-keys";
import { sha256Hex } from "@/lib/webhook-verify";

export async function registerWorkspaceWebhook(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  apiKey: string,
  opts?: { appUrl?: string }
): Promise<{ ok: boolean; warning?: string }> {
  const appUrl = opts?.appUrl || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const token = randomBytes(32).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const url = `${appUrl}/api/webhooks/zernio/${token}`;

  const zernio = createZernioClient(apiKey);

  // Best effort: drop a previous registration so the workspace never has two.
  const { data: existing } = await supabase
    .from("workspaces")
    .select("zernio_webhook_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (existing?.zernio_webhook_id) {
    try {
      await zernio.webhooks.deleteWebhookSettings({ query: { id: existing.zernio_webhook_id } });
    } catch {
      // Old registration may already be gone or the key can't manage it.
    }
  }

  let webhookId: string | null = null;
  try {
    const res = await zernio.webhooks.createWebhookSettings({
      body: {
        name: `zernflow-${workspaceId.slice(0, 8)}`,
        url,
        secret,
        events: ["message.received", "comment.received"],
      },
    });
    webhookId = res.data?.webhook?._id ?? null;
    if (!webhookId) throw new Error("no webhook id in response");
  } catch {
    return {
      ok: false,
      warning:
        "Webhook registration failed — inbound messages will not arrive. Run scripts/register-webhook.mjs with an authorized key, or retry after deploying to a public URL.",
    };
  }

  const { error } = await setWebhookCredentials(supabase, workspaceId, {
    tokenHash: sha256Hex(token),
    secret,
    zernioWebhookId: webhookId,
  });
  if (error) {
    // Credentials failed to persist — the registered webhook would deliver
    // events we can't verify. Remove it.
    try {
      await zernio.webhooks.deleteWebhookSettings({ query: { id: webhookId } });
    } catch {
      // best effort
    }
    return { ok: false, warning: "Webhook registered but credentials failed to save; rolled back." };
  }

  return { ok: true };
}

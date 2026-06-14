/**
 * OUTBOUND webhook dispatcher. Fire-and-forget: every call is wrapped so it can
 * never throw into (or delay) the engine / inbound-webhook caller.
 *
 * Hardening vs upstream:
 * - the per-endpoint signing secret is stored ENCRYPTED on the endpoint row and is
 *   read + decrypted only via lib/workspace-keys (custody invariant) — never plaintext here;
 * - delivery goes through lib/flow-engine/safe-fetch (SSRF guard) because the endpoint URL is
 *   customer-authored — a URL resolving to a private/reserved address is rejected and counted
 *   as a failed delivery (so a misconfigured/hostile endpoint auto-disables);
 * - never logs the secret, signature, payload, or customer URL.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { createServiceClient } from "@/lib/supabase/server";
import { getActiveWebhookEndpoints } from "@/lib/workspace-keys";
import { safeFetch } from "@/lib/flow-engine/safe-fetch";
import {
  type WebhookEventType,
  buildWebhookPayload,
  signWebhookPayload,
  isDeliverySuccess,
  nextFailureState,
} from "@/lib/webhook-events";

export type { WebhookEventType };

async function recordFailure(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  endpointId: string,
  currentCount: number
): Promise<void> {
  const { failureCount, disabled } = nextFailureState(currentCount);
  const updates: Database["public"]["Tables"]["webhook_endpoints"]["Update"] = {
    failure_count: failureCount,
  };
  if (disabled) updates.is_active = false;
  await supabase
    .from("webhook_endpoints")
    .update(updates)
    .eq("id", endpointId)
    .eq("workspace_id", workspaceId);
}

/**
 * Deliver `event` to every active endpoint in `workspaceId` subscribed to it.
 * HMAC-SHA256 signs the body (header X-Zernflow-Signature) when the endpoint has
 * a secret. Resets failure_count on a 2xx; increments + auto-disables at 10 otherwise.
 */
export async function dispatchWebhookEvent(
  workspaceId: string,
  event: WebhookEventType,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = await createServiceClient();
    const endpoints = await getActiveWebhookEndpoints(supabase, workspaceId, event);
    if (endpoints.length === 0) return;

    const body = JSON.stringify(buildWebhookPayload(event, data, new Date().toISOString()));

    await Promise.allSettled(
      endpoints.map(async (endpoint) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": "Zernflow-Webhook/1.0",
        };
        if (endpoint.secret) {
          headers["X-Zernflow-Signature"] = signWebhookPayload(body, endpoint.secret);
        }

        try {
          const { status } = await safeFetch(endpoint.url, { method: "POST", headers, body });
          if (isDeliverySuccess(status)) {
            await supabase
              .from("webhook_endpoints")
              .update({ last_triggered_at: new Date().toISOString(), failure_count: 0 })
              .eq("id", endpoint.id)
              .eq("workspace_id", workspaceId);
          } else {
            await recordFailure(supabase, workspaceId, endpoint.id, endpoint.failureCount);
          }
        } catch {
          // Network error, timeout, body-cap, or SSRF rejection — all are failed deliveries.
          await recordFailure(supabase, workspaceId, endpoint.id, endpoint.failureCount);
        }
      })
    );
  } catch (err) {
    // Last-resort guard: dispatch must never crash the caller.
    console.error("webhook dispatch error:", err instanceof Error ? err.message : "unknown");
  }
}

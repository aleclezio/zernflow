/**
 * Minimal security audit trail. Fire-and-forget: logging must never break
 * the request path, and metadata must never contain secrets — reasons and
 * identifiers only.
 */
import { createServiceClient } from "@/lib/supabase/server";

export type SecurityEventType =
  | "key_saved"
  | "webhook_sig_rejected"
  | "webhook_replay"
  | "cron_auth_failed"
  | "test_key_rejected";

export async function logSecurityEvent(
  eventType: SecurityEventType,
  workspaceId: string | null,
  metadata: Record<string, string | number | boolean> = {}
): Promise<void> {
  try {
    const supabase = await createServiceClient();
    await supabase.from("security_events").insert({
      event_type: eventType,
      workspace_id: workspaceId,
      metadata,
    });
  } catch (err) {
    console.error("security-events: failed to record", eventType, err);
  }
}

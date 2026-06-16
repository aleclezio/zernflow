/**
 * Send-path observability. Records every inbox-send attempt + outcome so a
 * failure is never silent, and maps Zernio SDK errors to SAFE user-facing
 * messages — the raw SDK text is stored server-side only and never returned to
 * clients (CLAUDE.md invariant #1).
 *
 * Fire-and-forget like security-events: recording must never break the send
 * path.
 */
import { createServiceClient } from "@/lib/supabase/server";

export type SendOutcome =
  | "success"
  | "guard_no_conversation"
  | "guard_no_late_id"
  | "guard_no_channel"
  | "guard_no_key"
  | "zernio_error"
  | "exception";

export interface ClassifiedSendError {
  /** Whether the failure was the Instagram/Meta 24h messaging window. */
  windowExpired: boolean;
  /** HTTP status the Zernio SDK reported, or null for a non-API throw. */
  zernioStatus: number | null;
  /** Raw error text — stored server-side ONLY, never returned to clients. */
  rawMessage: string;
  /** Safe, plain message for the UI. Never contains raw SDK text. */
  userMessage: string;
  /** Table outcome bucket: an API error vs an unexpected throw. */
  outcome: Extract<SendOutcome, "zernio_error" | "exception">;
}

const WINDOW_MSG =
  "Instagram won't deliver this — the contact hasn't messaged in the last 24 hours, so the messaging window is closed. They need to message you again to reopen it.";
const RATE_MSG =
  "Zernio is rate-limiting sends right now. Wait a moment and try again.";
const AUTH_MSG =
  "The account connection was rejected (auth or permissions). Reconnect the account or check the API key in Settings.";
const GENERIC_MSG =
  "Couldn't send the message. The error has been logged for review.";

/**
 * Map a thrown send error to a safe classification. Pure — no I/O.
 * The Zernio SDK throws an Error carrying a numeric `statusCode`.
 */
export function classifySendError(error: unknown): ClassifiedSendError {
  // Bound the stored size — error.message is an uncontrolled string from a
  // third-party SDK landing in durable storage.
  const rawMessage = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const statusCode =
    typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? ((error as { statusCode: number }).statusCode)
      : null;

  // Text match on Zernio's current 403 wording. If Zernio rewords/localizes it,
  // this degrades to the generic message — the statusCode is still recorded, so
  // telemetry isn't lost, only the specific user copy.
  const windowExpired = /outside of allowed window|messaging window|24[\s-]?hour/i.test(
    rawMessage
  );

  let userMessage = GENERIC_MSG;
  if (windowExpired) {
    userMessage = WINDOW_MSG;
  } else if (statusCode === 429 || /rate.?limit|too many requests/i.test(rawMessage)) {
    userMessage = RATE_MSG;
  } else if (
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthor|forbidden|invalid api key|insufficient scope/i.test(rawMessage)
  ) {
    userMessage = AUTH_MSG;
  }

  return {
    windowExpired,
    zernioStatus: statusCode,
    rawMessage,
    userMessage,
    outcome: statusCode !== null ? "zernio_error" : "exception",
  };
}

export interface SendAttemptRecord {
  workspaceId: string | null;
  conversationId: string | null;
  lateConversationId: string | null;
  accountId: string | null;
  platform: string | null;
  outcome: SendOutcome;
  httpStatus: number;
  zernioStatus?: number | null;
  /** Raw error text — server-side only. */
  errorMessage?: string | null;
  msSinceLastInbound?: number | null;
  textLength?: number | null;
}

/**
 * Persist one send attempt. Never throws (errors are swallowed + logged), so
 * it's safe to await inline in the request path without risking the send.
 * Service-role write (the table is service-role only).
 */
export async function recordSendAttempt(rec: SendAttemptRecord): Promise<void> {
  try {
    const supabase = await createServiceClient();
    await supabase.from("send_attempts").insert({
      workspace_id: rec.workspaceId,
      conversation_id: rec.conversationId,
      late_conversation_id: rec.lateConversationId,
      account_id: rec.accountId,
      platform: rec.platform,
      outcome: rec.outcome,
      http_status: rec.httpStatus,
      zernio_status: rec.zernioStatus ?? null,
      error_message: rec.errorMessage ?? null,
      ms_since_last_inbound: rec.msSinceLastInbound ?? null,
      text_length: rec.textLength ?? null,
    });
  } catch (err) {
    console.error("send-attempts: failed to record", rec.outcome, err);
  }
}

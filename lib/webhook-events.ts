/**
 * Pure helpers + event vocabulary for OUTBOUND webhook delivery (no DB/network),
 * so the dispatcher's logic is unit-testable.
 *
 * Outbound contract (us -> customer): HMAC-SHA256 hex signature in the
 * `X-Zernflow-Signature` header, UA `Zernflow-Webhook/1.0`. This is distinct
 * from the INBOUND `X-Zernio-Signature` contract (Zernio -> us) in
 * lib/webhook-verify.ts.
 */
import crypto from "node:crypto";

/** The events this fork actually dispatches — one per wired call site (5 engine + 2 inbound). */
export type WebhookEventType =
  | "contact.created"
  | "message.received"
  | "message.sent"
  | "flow.started"
  | "flow.completed"
  | "tag.added"
  | "tag.removed";

/**
 * Subscribable events. Intentionally only the 7 that have a dispatch site —
 * we never advertise an event we don't send (upstream's contact.updated /
 * conversation.opened / conversation.closed have no source here).
 */
export const WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  "contact.created",
  "message.received",
  "message.sent",
  "flow.started",
  "flow.completed",
  "tag.added",
  "tag.removed",
];

export function isValidWebhookEvent(event: string): event is WebhookEventType {
  return (WEBHOOK_EVENTS as readonly string[]).includes(event);
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** The delivery envelope sent as the POST body. `timestamp` is passed in (testable). */
export function buildWebhookPayload(
  event: string,
  data: Record<string, unknown>,
  timestamp: string
): WebhookPayload {
  return { event, timestamp, data };
}

/** HMAC-SHA256 hex over the exact serialized body — what the receiver recomputes. */
export function signWebhookPayload(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/** A delivery succeeded iff the endpoint returned a 2xx status. */
export function isDeliverySuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Failure bookkeeping after a failed delivery: increment the consecutive-failure
 * count and auto-disable once it reaches 10 (mirrors Zernio's own 10-strike rule
 * for the inbound side). A successful delivery resets the count elsewhere.
 */
export function nextFailureState(currentCount: number): { failureCount: number; disabled: boolean } {
  const failureCount = (currentCount || 0) + 1;
  return { failureCount, disabled: failureCount >= 10 };
}

/** A signing secret, auto-generated when an endpoint is created without one (192 bits). */
export function generateWebhookSecret(): string {
  return "whsec_" + crypto.randomBytes(24).toString("hex");
}

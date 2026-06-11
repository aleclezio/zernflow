/**
 * Webhook signature verification helpers (Zernio contract):
 * - HMAC-SHA256 hex of the raw request body
 * - canonical header X-Zernio-Signature; X-Late-Signature is a legacy alias
 *   honored only when the canonical header is absent (empty string = absent)
 * - delivery is at-least-once with a stable event id -> replay defense is
 *   event-id dedupe, handled by the route
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time HMAC check. Length mismatch returns false — never throws. */
export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.toLowerCase();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Canonical signature header wins; legacy alias only when canonical absent. */
export function pickSignatureHeader(headers: Headers): string | null {
  const canonical = headers.get("x-zernio-signature");
  if (canonical) return canonical;
  const legacy = headers.get("x-late-signature");
  return legacy || null;
}

const MAX_EVENT_ID_LENGTH = 128;

/**
 * Stable event id for dedupe: header, then payload.id; otherwise (or when the
 * id is oversized/forged-looking) a synthetic sha256 of the raw body, flagged
 * so the route can log the anomaly.
 */
export function resolveEventId(
  headers: Headers,
  payload: { id?: unknown },
  rawBody: string
): { eventId: string; synthetic: boolean } {
  const candidate = headers.get("x-zernio-event-id") || payload.id;
  if (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= MAX_EVENT_ID_LENGTH
  ) {
    return { eventId: candidate, synthetic: false };
  }
  return {
    eventId: createHash("sha256").update(rawBody).digest("hex"),
    synthetic: true,
  };
}

/** sha256 hex — used for webhook URL token lookup (store hash, not token). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Pure API-key helpers (no DB/network), so the auth-layer logic is unit-testable.
 */
import crypto from "node:crypto";

/** Generate a new `zf_`-prefixed API key (192 bits of entropy). Full key shown ONCE. */
export function generateApiKey(): string {
  return "zf_" + crypto.randomBytes(24).toString("hex");
}

/**
 * SHA-256 hex of the raw key — what is stored (api_keys.key_hash) and what the
 * verify path recomputes. Issue and verify MUST use this same function.
 */
export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Display identifier: the first 12 chars + ellipsis. Reveals no usable secret. */
export function keyPrefix(raw: string): string {
  return raw.slice(0, 12) + "...";
}

/**
 * True if a key with this `expiresAt` (ISO string, or null = never expires) is
 * expired at `nowMs`. Fails closed: an unparseable timestamp is treated as
 * expired so a corrupted value can never authenticate.
 */
export function isApiKeyExpired(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) return false;
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return true;
  return expiresMs <= nowMs;
}

/**
 * Pure API-key helpers (no DB/network), so the auth-layer logic is unit-testable.
 * Key issuance/hash/prefix helpers are added alongside the management endpoints.
 */

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

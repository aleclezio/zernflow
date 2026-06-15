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

/**
 * Per-key API scopes. `read` = GET/list; `write` = create/update/delete;
 * `send` = outbound messaging (inbox replies, broadcast send). A key holds an
 * explicit subset; each v1 route declares the scope it needs (see authorizeApiV1).
 */
export const API_SCOPES = ["read", "write", "send"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(s: unknown): s is ApiScope {
  return typeof s === "string" && (API_SCOPES as readonly string[]).includes(s);
}

/**
 * Validate + dedupe a requested scope list (e.g. from a key-creation request).
 * Returns null if the input is not an array, contains an unknown scope, or is
 * empty — callers should 400 on null. Order is normalised to API_SCOPES order.
 */
export function parseScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input)) return null;
  for (const s of input) if (!isApiScope(s)) return null;
  const set = new Set(input as ApiScope[]);
  const out = API_SCOPES.filter((s) => set.has(s));
  return out.length > 0 ? out : null;
}

/**
 * True if a key bearing `scopes` may perform an action requiring `required`.
 * null/undefined `scopes` = full access (backward-compat for keys minted before
 * the scopes column existed; the DB default also backfills those rows to full).
 */
export function hasScope(scopes: readonly string[] | null | undefined, required: ApiScope): boolean {
  if (scopes == null) return true;
  return scopes.includes(required);
}

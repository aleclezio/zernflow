/**
 * In-memory fixed-window rate limiter.
 *
 * Deliberately in-memory: the deployment target is a single-node container
 * (troy-vps). If the app is ever scaled horizontally this must move to a
 * shared store (Redis/Postgres) — documented in the README runbook.
 */

interface Entry {
  count: number;
  windowStart: number;
  windowMs: number;
}

const entries = new Map<string, Entry>();

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of entries) {
    if (now - entry.windowStart >= entry.windowMs) entries.delete(key);
  }
}

/**
 * Returns true if the call is allowed, false if the key exceeded `limit`
 * calls within the current `windowMs` window.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);

  const entry = entries.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    entries.set(key, { count: 1, windowStart: now, windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

/** Test-only helpers. */
export function _resetRateLimits() {
  entries.clear();
  lastSweep = 0;
}
export function _entryCountForTests() {
  return entries.size;
}

/**
 * Admin endpoint auth for operator-only tools (client onboarding). Bearer
 * header ONLY, compared digest-first (sha256 both sides, then timingSafeEqual)
 * so the configured secret's length never leaks through timing.
 *
 * Distinct from CRON_SECRET: onboarding can provision tenants + issue keys, so
 * it carries its own token (ONBOARD_ADMIN_TOKEN) that rotates independently.
 * Fail-closed: refuses everything when the token is unset or empty.
 *
 * Defense-in-depth, not the only gate — these routes also sit behind the
 * Cloudflare Access edge on os.lygge.com.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export function requireAdminAuth(request: NextRequest): boolean {
  const secret = process.env.ONBOARD_ADMIN_TOKEN;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);
  if (!provided) return false;

  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Cron endpoint auth: Bearer header ONLY. The upstream `?key=` query param is
 * gone — URL secrets end up in access logs, proxies, and browser history.
 *
 * Comparison is digest-first (sha256 both sides, then timingSafeEqual) so
 * the length of the configured secret never leaks through timing.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export function requireCronAuth(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);

  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

# CLAUDE.md — zernflow (fork)

Hardened fork of `zernio-dev/zernflow` (upstream remote kept). Multi-client
engagement automation on the Zernio API. Deploy target: single-node Docker on
a VPS behind Cloudflare.

## Commands

```bash
npm run dev                 # next dev (needs local Supabase + .env.local)
npm run build               # next build (standalone output)
npm run lint                # eslint (flat config; `next lint` is gone in Next 16)
npm run typecheck           # tsc --noEmit
npm test                    # full vitest suite (unit + integration)
npm run test:unit           # pure unit tests only
npm run test:integration    # against the LOCAL supabase stack
npm run test:e2e            # Playwright e2e (build first; needs local supabase + `npx playwright install chromium`)
bash scripts/check-key-access.sh   # CI guard: key-column access
node scripts/smoke-test.mjs        # live e2e vs a running app
```

Local stack: `npx supabase start` (Docker Desktop must be running) →
`npx supabase migration up` → `node scripts/dev-env.mjs` (writes `.env.local`
including generated CRON_SECRET + APP_ENCRYPTION_KEY).

## Branch discipline

`dev` is the working branch (default). `main` is protected: PR-only, no
force-push. CI (lint + typecheck + unit, then integration vs `supabase
start`) must be green — "done" means CI green, not local green.

Keep upstreamable commits (security/scoping fixes that make sense for
upstream PRs) separate from ours-only commits (CI, Dockerfile, pinning,
README-fork).

## Security invariants — do not regress

1. **Key custody**: the columns `late_api_key_encrypted`, `ai_api_key`,
   `webhook_secret_encrypted` are ONLY touched via `lib/workspace-keys.ts`
   (encrypt-on-write, fail-closed decrypt; AAD = workspace id). Enforced by
   `scripts/check-key-access.sh` in CI. Never log or echo key material; SDK
   errors are never returned to clients verbatim.
2. **Profile scoping**: every workspace is bound to ONE Zernio profile
   (unique index). Account listing/connecting is filtered by the binding and
   fails closed (412 PROFILE_UNBOUND). Never reintroduce a `profiles[0]`
   fallback or an unfiltered `listAccounts()`. Ambiguity is never guessed —
   the user picks.
3. **Webhooks**: verify-FIRST ordering in `app/api/webhooks/zernio/[token]`
   (token → secret → timingSafeEqual → only then JSON.parse). Secret is
   mandatory. Dedupe insert-BEFORE-process. Unknown accounts get 200-skip,
   never 404 (Zernio disables a webhook after 10 consecutive failures).
4. **Tenant isolation**: `scheduled_jobs`, `webhook_events`,
   `security_events`, and channel INSERT/DELETE are service-role only.
   `increment_*` RPCs are not callable by anon/authenticated. Engine entity
   loads are always scoped to `context.workspaceId`. Flow execution carries a
   global node budget — goToFlow must never reset it.
5. **Cron**: Bearer header only, digest-compare. No secrets in URLs.
6. **HTTP node**: all outbound flow requests go through
   `lib/flow-engine/safe-fetch.ts` (public-IP-only policy). Never call plain
   `fetch` with user-authored URLs.
7. **TDD**: security fixes start with a red test proving the hole. The
   integration suite runs against the real local stack (real RLS) — keep it
   that way; mock only the cookie plumbing and the Zernio SDK.

## Gotchas

- The machine-global gitignore pattern `*token*` matches the `[token]` route
  directory — the repo `.gitignore` re-includes it; keep that negation.
- `lib/types/database.ts` is hand-maintained (extra Platform/NodeType types);
  add new tables/columns there manually, don't overwrite with `supabase gen`.
- Docker Desktop clock skew after host sleep makes fresh JWTs "issued at
  future"; the integration helper retries — if a whole run fails this way,
  restart Docker Desktop.

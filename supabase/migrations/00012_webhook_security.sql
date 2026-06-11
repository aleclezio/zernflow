-- ============================================================
-- WEBHOOK SECURITY
-- ============================================================
-- Per-workspace capability-URL webhook with a MANDATORY secret:
--   /api/webhooks/zernio/<token>   (we store sha256(token), never the token)
-- Zernio delivers at-least-once with a stable event id -> webhook_events
-- provides insert-before-process dedupe.

alter table workspaces
  add column if not exists webhook_token_hash text,
  add column if not exists webhook_secret_encrypted text,
  add column if not exists zernio_webhook_id text;

create unique index if not exists idx_workspaces_webhook_token_hash
  on workspaces (webhook_token_hash)
  where webhook_token_hash is not null;

create table webhook_events (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  event_id text not null check (char_length(event_id) <= 128),
  synthetic boolean not null default false,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (workspace_id, event_id)
);

-- For the 7-day retention sweep in the cron processor.
create index idx_webhook_events_received on webhook_events (received_at);

-- Service-role only: RLS enabled with no policies.
alter table webhook_events enable row level security;

-- The per-channel webhook columns were dead upstream code (nothing ever
-- wrote them; the HMAC branch reading webhook_secret was unreachable).
alter table channels drop column if exists webhook_id;
alter table channels drop column if exists webhook_secret;

-- ============================================================
-- SEND OBSERVABILITY
-- ============================================================
-- Records EVERY inbox-send attempt and its outcome (success, the specific
-- guard that tripped, or the real Zernio error) so failures are never silent.
-- Service-role only (mirrors security_events). The send route writes via the
-- service client; the cron processor sweeps rows older than 90 days.
--
-- Raw Zernio error text is stored here for debugging ONLY — it is never
-- returned to clients (CLAUDE.md invariant #1: SDK errors are mapped to safe
-- user messages before they leave the server).

-- When the contact last messaged us (inbound). Lets the send route record how
-- long after the contact's last message a send was attempted — i.e. whether a
-- failure was the Instagram 24h messaging window. Set by the inbound webhook.
alter table conversations add column if not exists last_inbound_at timestamptz;

create table send_attempts (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid references workspaces(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  late_conversation_id text,
  account_id text,
  platform text,
  outcome text not null check (outcome in (
    'success',
    'guard_no_conversation',
    'guard_no_late_id',
    'guard_no_channel',
    'guard_no_key',
    'zernio_error',
    'exception'
  )),
  http_status integer not null,
  zernio_status integer,
  error_message text,
  ms_since_last_inbound bigint,
  text_length integer,
  created_at timestamptz not null default now()
);

create index idx_send_attempts_ws on send_attempts (workspace_id, created_at desc);
create index idx_send_attempts_outcome on send_attempts (outcome, created_at desc);
-- Drives the 90-day retention sweep in the cron processor.
create index idx_send_attempts_created on send_attempts (created_at);

alter table send_attempts enable row level security;
-- Service-role only: no policies (mirrors security_events). The service client
-- bypasses RLS; anon/authenticated get no rows.

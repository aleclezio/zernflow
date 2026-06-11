-- ============================================================
-- SECURITY EVENTS (first cut)
-- ============================================================
-- Minimal audit trail for the hardened surfaces. Feeds WAF/alert tuning in
-- the deploy session. Service-role only.

create table security_events (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid references workspaces(id) on delete cascade,
  event_type text not null check (event_type in (
    'key_saved',
    'webhook_sig_rejected',
    'webhook_replay',
    'cron_auth_failed',
    'test_key_rejected'
  )),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_security_events_ws on security_events (workspace_id, created_at desc);
create index idx_security_events_type on security_events (event_type, created_at desc);

alter table security_events enable row level security;

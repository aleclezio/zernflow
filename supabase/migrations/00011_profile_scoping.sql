-- ============================================================
-- PROFILE SCOPING
-- ============================================================
-- Each workspace binds to exactly ONE Zernio profile. All account
-- syncing/connecting is filtered by this binding (fail-closed: routes
-- return 412 PROFILE_UNBOUND until a profile is bound via test-key).

alter table workspaces
  add column if not exists zernio_profile_id text,
  add column if not exists zernio_profile_name text;

-- 1:1 profile <-> workspace. Two workspaces can never sync the same
-- profile's accounts.
create unique index if not exists idx_workspaces_zernio_profile
  on workspaces (zernio_profile_id)
  where zernio_profile_id is not null;

-- One ACTIVE channel per Zernio account globally. Webhook routing by
-- account id within a workspace can never be ambiguous, and an account
-- can never fire flows in two workspaces at once.
-- (Existing rows: deactivate duplicates before applying on a live install;
-- fresh installs are unaffected.)
create unique index if not exists idx_channels_active_late_account
  on channels (late_account_id)
  where is_active;

-- ============================================================
-- TENANT LOCKDOWN
-- ============================================================

-- 1) scheduled_jobs: service-role only.
-- 00009 granted INSERT/SELECT/UPDATE to ANY authenticated user, letting any
-- signup inject resume_flow / send_broadcast jobs that the cron processor
-- then executed with the service role.
drop policy if exists "Authenticated users can insert jobs" on scheduled_jobs;
drop policy if exists "Authenticated users can read jobs" on scheduled_jobs;
drop policy if exists "Authenticated users can update jobs" on scheduled_jobs;
-- RLS stays enabled with no policies: only the service role can touch it.

-- 2) increment_* RPCs: pin search_path and revoke from anon/authenticated.
-- They are SECURITY DEFINER with no workspace check — only trusted server
-- code (service role) may call them.
alter function increment_unread(uuid, text) set search_path = public;
alter function increment_broadcast_sent(uuid) set search_path = public;
alter function increment_broadcast_failed(uuid) set search_path = public;

revoke execute on function increment_unread(uuid, text) from public, anon, authenticated;
revoke execute on function increment_broadcast_sent(uuid) from public, anon, authenticated;
revoke execute on function increment_broadcast_failed(uuid) from public, anon, authenticated;

-- 3) workspaces: credential/binding columns are OWNER-only.
-- RLS cannot compare OLD vs NEW, so a trigger gates the sensitive columns;
-- plain fields (name, global_keywords) stay member-editable.
create or replace function guard_workspace_credential_columns()
returns trigger as $$
begin
  if (new.late_api_key_encrypted   is distinct from old.late_api_key_encrypted
   or new.ai_api_key               is distinct from old.ai_api_key
   or new.webhook_secret_encrypted is distinct from old.webhook_secret_encrypted
   or new.webhook_token_hash       is distinct from old.webhook_token_hash
   or new.zernio_webhook_id        is distinct from old.zernio_webhook_id
   or new.zernio_profile_id        is distinct from old.zernio_profile_id
   or new.zernio_profile_name      is distinct from old.zernio_profile_name) then
    -- service-role requests have no auth.uid(): trusted server code.
    if auth.uid() is not null and not exists (
      select 1 from workspace_members wm
      where wm.workspace_id = new.id
        and wm.user_id = auth.uid()
        and wm.role = 'owner'
    ) then
      raise exception 'only the workspace owner can change credential columns';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists guard_workspace_credentials on workspaces;
create trigger guard_workspace_credentials
  before update on workspaces
  for each row execute function guard_workspace_credential_columns();

-- 4) channels: INSERT/DELETE are server-side only (sync of key-verified
-- accounts); members keep SELECT and UPDATE (is_active toggle in the UI).
drop policy if exists "Users can manage channels in their workspaces" on channels;

create policy "Users can update channels in their workspaces"
  on channels for update
  using (is_workspace_member(workspace_id));
-- no INSERT/DELETE policies: service role only.

-- UPDATE-rebinding is the same attack as INSERT-planting: gate the identity
-- columns so member updates can only touch UI fields (is_active etc.).
create or replace function guard_channel_identity_columns()
returns trigger as $$
begin
  if (new.late_account_id is distinct from old.late_account_id
   or new.workspace_id    is distinct from old.workspace_id
   or new.platform        is distinct from old.platform) then
    if auth.uid() is not null then
      raise exception 'channel identity columns can only be changed by server-side sync';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists guard_channel_identity on channels;
create trigger guard_channel_identity
  before update on channels
  for each row execute function guard_channel_identity_columns();

-- ============================================================
-- 00018 — Round-robin inbox assignment (atomic)
-- ============================================================
-- assign_next_member picks the next workspace member in rotation and assigns the
-- given brand-new conversation to them, advancing the per-workspace counter.
--
-- It runs under a FOR UPDATE lock on the workspaces row, so concurrent inbound
-- webhooks serialize on the counter — no SELECT-then-UPDATE race, so two
-- simultaneous new conversations can never land on the same index (fair, even
-- rotation). Upstream's two-write version had exactly that race.
--
-- No-ops (returns NULL) unless auto_assign_mode = 'round-robin', and on an unknown
-- workspace or a workspace with no members. Returns the assigned user id otherwise.
--
-- SECURITY DEFINER + pinned search_path + execute revoked from anon/authenticated
-- (service-role only — called from the inbound webhook), matching the increment_*
-- RPCs (00003 / 00013). The conversation update is tenant-scoped (id + workspace_id)
-- as defense-in-depth even though the caller already owns the row.

create or replace function assign_next_member(p_workspace_id uuid, p_conversation_id uuid)
returns uuid as $$
declare
  v_idx int;
  v_mode text;
  v_count int;
  v_pick int;
  v_assignee uuid;
begin
  -- Serialize concurrent assignments on the workspace counter row.
  select last_assigned_member_index, auto_assign_mode
    into v_idx, v_mode
  from workspaces
  where id = p_workspace_id
  for update;

  if not found or v_mode is distinct from 'round-robin' then
    return null;
  end if;

  select count(*) into v_count
  from workspace_members
  where workspace_id = p_workspace_id;

  if v_count = 0 then
    return null;
  end if;

  -- Member at the current index (wraps if the team shrank); stable ordering so
  -- the rotation is deterministic across calls.
  v_pick := v_idx % v_count;

  select user_id into v_assignee
  from workspace_members
  where workspace_id = p_workspace_id
  order by created_at asc, user_id asc
  offset v_pick
  limit 1;

  if v_assignee is null then
    return null;
  end if;

  update conversations
  set assigned_to = v_assignee
  where id = p_conversation_id
    and workspace_id = p_workspace_id;

  update workspaces
  set last_assigned_member_index = (v_idx + 1) % v_count
  where id = p_workspace_id;

  return v_assignee;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function assign_next_member(uuid, uuid) from public, anon, authenticated;

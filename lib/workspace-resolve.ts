// Pure workspace resolution for the unified shell (os.lygge.com).
// The command-centre sets active_profile_id when the operator switches client;
// it maps to workspaces.zernio_profile_id (1:1 binding). Kept free of
// next/headers + supabase so it unit-tests without request scope.

export interface MembershipBinding {
  workspace_id: string;
  zernio_profile_id: string | null;
}

export interface ResolveCookies {
  /** active_profile_id — set by the command-centre client switcher. */
  activeProfileId?: string | null;
  /** zernflow_workspace_id — ZernFlow's own last-selected workspace. */
  workspaceId?: string | null;
}

/**
 * Resolution order: active_profile_id (when it maps to exactly one accessible
 * workspace) → workspace cookie (when still a membership) → null (caller
 * falls back to the first membership).
 */
export function resolveWorkspaceId(
  memberships: MembershipBinding[],
  cookies: ResolveCookies,
): string | null {
  const { activeProfileId, workspaceId } = cookies;

  if (activeProfileId) {
    const matches = memberships.filter(
      (m) => m.zernio_profile_id !== null && m.zernio_profile_id === activeProfileId,
    );
    if (matches.length === 1) return matches[0].workspace_id;
  }

  if (workspaceId && memberships.some((m) => m.workspace_id === workspaceId)) {
    return workspaceId;
  }

  return null;
}

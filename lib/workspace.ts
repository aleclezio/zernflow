import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { resolveWorkspaceId } from "@/lib/workspace-resolve";

export const WORKSPACE_COOKIE = "zernflow_workspace_id";
// Set by the command-centre client switcher (same origin under os.lygge.com):
// carries the selected client's Zernio profile id.
export const PROFILE_COOKIE = "active_profile_id";

/**
 * Cached per-request: deduplicates across layout + page in the same render.
 * Resolution: active_profile_id (unified shell) → workspace cookie → first
 * membership. Unknown/unbound profile falls through, never errors.
 */
export const getWorkspace = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const cookieStore = await cookies();

  const { data: memberships } = await supabase
    .from("workspace_members")
    .select("workspace_id, role, workspaces(*)")
    .eq("user_id", user.id);

  const accessible = (memberships ?? []).filter((m) => m.workspaces);
  if (accessible.length === 0) redirect("/login");

  const resolvedId = resolveWorkspaceId(
    accessible.map((m) => ({
      workspace_id: m.workspace_id,
      zernio_profile_id: m.workspaces!.zernio_profile_id,
    })),
    {
      activeProfileId: cookieStore.get(PROFILE_COOKIE)?.value,
      workspaceId: cookieStore.get(WORKSPACE_COOKIE)?.value,
    },
  );

  const membership =
    accessible.find((m) => m.workspace_id === resolvedId) ?? accessible[0];

  return {
    user,
    workspace: membership.workspaces!,
    role: membership.role,
    supabase,
  };
});

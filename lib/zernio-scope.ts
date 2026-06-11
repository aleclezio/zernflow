/**
 * Profile scoping: every workspace is bound to exactly one Zernio profile
 * (workspaces.zernio_profile_id, unique). All account listing/connecting is
 * filtered by this binding.
 *
 * Fail-closed: an unbound workspace cannot sync or connect anything — routes
 * return 412 PROFILE_UNBOUND until the owner binds a profile via test-key.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

export class ProfileUnboundError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} has no Zernio profile bound`);
    this.name = "ProfileUnboundError";
  }
}

/** The workspace's bound profile id. Throws ProfileUnboundError when unset. */
export async function getBoundProfileId(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<string> {
  const { data } = await supabase
    .from("workspaces")
    .select("zernio_profile_id")
    .eq("id", workspaceId)
    .maybeSingle();

  const profileId = data?.zernio_profile_id;
  if (!profileId) throw new ProfileUnboundError(workspaceId);
  return profileId;
}

/** Standard 412 response for unbound workspaces. */
export function profileUnboundResponse() {
  return NextResponse.json(
    {
      code: "PROFILE_UNBOUND",
      error:
        "No Zernio profile is bound to this workspace yet. Save your API key in Settings to bind one.",
    },
    { status: 412 }
  );
}

/**
 * Normalize SocialAccount.profileId — the API returns either the id string
 * or a populated Profile object.
 */
export function accountProfileId(account: {
  profileId?: string | { _id?: string };
}): string | undefined {
  return typeof account.profileId === "string" ? account.profileId : account.profileId?._id;
}

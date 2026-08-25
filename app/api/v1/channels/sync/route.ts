import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { authorizeApiV1 } from "@/lib/api-auth";
import { createZernioClient } from "@/lib/zernio-client";
import { getZernioKey } from "@/lib/workspace-keys";
import {
  getBoundProfileId,
  ProfileUnboundError,
  profileUnboundResponse,
  accountProfileId,
} from "@/lib/zernio-scope";

/**
 * POST /api/v1/channels/sync
 *
 * Syncs all Zernio accounts as channels for the current workspace.
 * Creates new channels for accounts not yet in the DB.
 * Deactivates channels whose Zernio accounts no longer exist.
 */
export async function POST(request: NextRequest) {
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const apiKey = await getZernioKey(supabase, auth.workspaceId);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Zernio API key not configured. Go to Settings first." },
      { status: 400 }
    );
  }

  let profileId: string;
  try {
    profileId = await getBoundProfileId(supabase, auth.workspaceId);
  } catch (err) {
    if (err instanceof ProfileUnboundError) return profileUnboundResponse();
    throw err;
  }

  const zernio = createZernioClient(apiKey);

  try {
    const res = await zernio.accounts.listAccounts({ query: { profileId } });
    const returned: Array<{
      _id?: string;
      platform?: string;
      username?: string;
      displayName?: string;
      profileId?: string | { _id?: string };
    }> = res.data?.accounts ?? [];

    // Defensive post-filter: the server already filtered by profileId, but a
    // foreign account slipping through would mean cross-client flow firing —
    // drop it and flag the anomaly.
    const lateAccounts = returned.filter((a) => accountProfileId(a) === profileId);
    if (lateAccounts.length !== returned.length) {
      console.error(
        `[anomaly] channels/sync: Zernio returned ${returned.length - lateAccounts.length} account(s) outside bound profile despite profileId filter (workspace ${auth.workspaceId})`
      );
    }

    // Get existing channels for this workspace
    const { data: existingChannels } = await supabase
      .from("channels")
      .select("*")
      .eq("workspace_id", auth.workspaceId);

    const existingByZernioId = new Map(
      (existingChannels ?? []).map((c) => [c.late_account_id, c])
    );

    // The SDK type doesn't declare profilePicture but the API returns it
    const lateAccountIds = new Set(lateAccounts.map((a: { _id?: string }) => a._id).filter(Boolean));

    // Deactivate channels whose Zernio accounts no longer exist in the bound
    // profile — BEFORE inserts, so the global active-account uniqueness index
    // never collides when an account moved between profiles/workspaces.
    let deactivated = 0;
    for (const channel of existingChannels ?? []) {
      if (!lateAccountIds.has(channel.late_account_id) && channel.is_active) {
        await supabase
          .from("channels")
          .update({ is_active: false })
          .eq("id", channel.id);
        deactivated++;
      }
    }

    let created = 0;
    let updated = 0;

    for (const account of lateAccounts) {
      if (!account._id) continue;
      const acc = account as typeof account & { profilePicture?: string };
      const profilePic = acc.profilePicture || null;

      const existing = existingByZernioId.get(account._id);

      if (existing) {
        if (
          existing.username !== (account.username || null) ||
          existing.display_name !== (account.displayName || account.username || null) ||
          existing.profile_picture !== profilePic
        ) {
          await supabase
            .from("channels")
            .update({
              username: account.username || null,
              display_name: account.displayName || account.username || null,
              profile_picture: profilePic,
            })
            .eq("id", existing.id);
          updated++;
        }
      } else {
        // Channel INSERT is service-role only (tenant lockdown): these
        // accounts were just verified against the workspace's scoped key.
        await (await createServiceClient()).from("channels").insert({
          workspace_id: auth.workspaceId,
          platform: account.platform as "facebook" | "instagram" | "twitter" | "telegram" | "bluesky" | "reddit",
          late_account_id: account._id,
          username: account.username || null,
          display_name: account.displayName || account.username || null,
          profile_picture: profilePic,
          is_active: true,
        });
        created++;
      }
    }

    // Return updated channel list
    const { data: channels } = await supabase
      .from("channels")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .order("created_at", { ascending: false });

    return NextResponse.json({
      channels: channels ?? [],
      synced: { created, updated, deactivated },
    });
  } catch (error) {
    console.error("Failed to sync channels:", error);
    return NextResponse.json(
      { error: `Failed to sync channels: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

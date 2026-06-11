import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createZernioClient } from "@/lib/zernio-client";
import { setZernioKey } from "@/lib/workspace-keys";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/v1/channels/test-key
 *
 * Validates a Zernio API key, saves it (encrypted at rest, AAD = workspace id)
 * to the workspace, and auto-syncs channels.
 *
 * Requires: authenticated user, OWNER of the target workspace.
 * Rate limited per user — this endpoint must not be a key-validation oracle.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!checkRateLimit(`test-key:${user.id}`, 5, 60_000)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => null);
  const apiKey = body?.apiKey;
  const workspaceId = body?.workspaceId;

  if (!apiKey || typeof apiKey !== "string" || !workspaceId || typeof workspaceId !== "string") {
    return NextResponse.json(
      { error: "apiKey and workspaceId are required" },
      { status: 400 }
    );
  }

  // Owner-only: members must not be able to swap the workspace key.
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership || membership.role !== "owner") {
    return NextResponse.json(
      { error: "Only the workspace owner can manage API keys" },
      { status: 403 }
    );
  }

  // Validate the key by listing accounts. SDK errors are never echoed —
  // they can embed request/auth details.
  let accounts: Array<{
    _id?: string;
    platform?: string;
    username?: string;
    displayName?: string;
    profilePicture?: string;
  }>;
  try {
    const zernio = createZernioClient(apiKey.trim());
    const res = await zernio.accounts.listAccounts();
    accounts = (res.data?.accounts ?? []) as typeof accounts;
  } catch {
    return NextResponse.json(
      { error: "Invalid API key or connection error" },
      { status: 400 }
    );
  }

  const { error: saveErr } = await setZernioKey(supabase, workspaceId, apiKey.trim());
  if (saveErr) {
    return NextResponse.json(
      { error: "Key valid but failed to save" },
      { status: 500 }
    );
  }

  // Auto-sync channels for this workspace
  const { data: existingChannels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspaceId);

  const existingByLateId = new Map(
    (existingChannels ?? []).map((c) => [c.late_account_id, c])
  );

  for (const account of accounts) {
    if (!account._id) continue;
    if (existingByLateId.has(account._id)) continue;

    await supabase.from("channels").insert({
      workspace_id: workspaceId,
      platform: account.platform as "facebook" | "instagram" | "twitter" | "telegram" | "bluesky" | "reddit",
      late_account_id: account._id,
      username: account.username || null,
      display_name: account.displayName || account.username || null,
      profile_picture: account.profilePicture || null,
      is_active: true,
    });
  }

  return NextResponse.json({ accounts });
}

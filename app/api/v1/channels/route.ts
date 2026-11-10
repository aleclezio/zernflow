import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionWorkspaceId } from "@/lib/api-auth";

export async function GET() {
  const supabase = await createClient();
  // The SELECTED workspace (same resolution as the Channels page), never the
  // first membership: Sync on one client's page must not act on another client.
  const workspaceId = await getSessionWorkspaceId();
  const workspace = workspaceId ? { id: workspaceId } : null;
  if (!workspace)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: channels, error } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(channels);
}

import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/** GET /api/v1/ref-links/:refLinkId — one ref link (workspace-scoped), with flow name/status. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ refLinkId: string }> }
) {
  const { refLinkId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data, error } = await supabase
    .from("ref_links")
    .select("*, flows(name, status)")
    .eq("id", refLinkId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

/** PUT /api/v1/ref-links/:refLinkId — update. Body (all optional): { name, flowId, channelId, is_active }. */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ refLinkId: string }> }
) {
  const { refLinkId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const { name, flowId, channelId, is_active } = body ?? {};

  const updates: { name?: string; flow_id?: string; channel_id?: string | null; is_active?: boolean } = {};
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    updates.name = trimmed;
  }
  if (typeof flowId === "string") updates.flow_id = flowId;
  if (channelId !== undefined) updates.channel_id = typeof channelId === "string" && channelId ? channelId : null;
  if (typeof is_active === "boolean") updates.is_active = is_active;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }


  // Re-pointed flow/channel must also belong to the caller's workspace.
  if (updates.flow_id) {
    const { data: flow } = await supabase
      .from("flows")
      .select("id")
      .eq("id", updates.flow_id)
      .eq("workspace_id", auth.workspaceId)
      .single();
    if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });
  }
  if (updates.channel_id) {
    const { data: channel } = await supabase
      .from("channels")
      .select("id")
      .eq("id", updates.channel_id)
      .eq("workspace_id", auth.workspaceId)
      .single();
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("ref_links")
    .update(updates)
    .eq("id", refLinkId)
    .eq("workspace_id", auth.workspaceId)
    .select("*, flows(name, status)")
    .single();

  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

/** DELETE /api/v1/ref-links/:refLinkId — delete (workspace-scoped). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ refLinkId: string }> }
) {
  const { refLinkId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { error } = await supabase
    .from("ref_links")
    .delete()
    .eq("id", refLinkId)
    .eq("workspace_id", auth.workspaceId);

  if (error) return NextResponse.json({ error: "Failed to delete ref link" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

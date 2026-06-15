import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/** PUT /api/v1/saved-replies/:replyId — update title/content/shortcut (workspace-scoped). */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ replyId: string }> }
) {
  const { replyId } = await params;
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const updates: { title?: string; content?: string; shortcut?: string | null } = {};
  if (body?.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) return NextResponse.json({ error: "Invalid title" }, { status: 400 });
    updates.title = title;
  }
  if (body?.content !== undefined) {
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 10000) return NextResponse.json({ error: "Invalid content" }, { status: 400 });
    updates.content = content;
  }
  if (body?.shortcut !== undefined) {
    if (body.shortcut !== null && typeof body.shortcut !== "string")
      return NextResponse.json({ error: "Invalid shortcut" }, { status: 400 });
    const shortcut = typeof body.shortcut === "string" ? body.shortcut.trim() : "";
    if (shortcut.length > 50) return NextResponse.json({ error: "Invalid shortcut" }, { status: 400 });
    updates.shortcut = shortcut || null;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_replies")
    .update(updates)
    .eq("id", replyId)
    .eq("workspace_id", auth.workspaceId)
    .select()
    .single();

  if (error || !data) return NextResponse.json({ error: "Saved reply not found" }, { status: 404 });
  return NextResponse.json(data);
}

/** DELETE /api/v1/saved-replies/:replyId — remove a canned reply (workspace-scoped). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ replyId: string }> }
) {
  const { replyId } = await params;
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { error } = await supabase
    .from("saved_replies")
    .delete()
    .eq("id", replyId)
    .eq("workspace_id", auth.workspaceId);

  if (error) return NextResponse.json({ error: "Failed to delete saved reply" }, { status: 500 });
  return NextResponse.json({ success: true });
}

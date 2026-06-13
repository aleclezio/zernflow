import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateRequest } from "@/lib/api-auth";

/** PUT /api/v1/saved-replies/:replyId — update title/content/shortcut (workspace-scoped). */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ replyId: string }> }
) {
  const { replyId } = await params;
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body?.title !== undefined) updates.title = body.title;
  if (body?.content !== undefined) updates.content = body.content;
  if (body?.shortcut !== undefined) updates.shortcut = body.shortcut || null;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supabase = await createClient();
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
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { error } = await supabase
    .from("saved_replies")
    .delete()
    .eq("id", replyId)
    .eq("workspace_id", auth.workspaceId);

  if (error) return NextResponse.json({ error: "Failed to delete saved reply" }, { status: 500 });
  return NextResponse.json({ success: true });
}

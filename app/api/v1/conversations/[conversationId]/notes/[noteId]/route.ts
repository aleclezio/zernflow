import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateRequest } from "@/lib/api-auth";

/** DELETE /api/v1/conversations/:conversationId/notes/:noteId — remove a note (workspace-scoped). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string; noteId: string }> }
) {
  const { noteId } = await params;
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { error } = await supabase
    .from("conversation_notes")
    .delete()
    .eq("id", noteId)
    .eq("workspace_id", auth.workspaceId);

  if (error) return NextResponse.json({ error: "Failed to delete note" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

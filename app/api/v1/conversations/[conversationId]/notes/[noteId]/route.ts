import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/** DELETE /api/v1/conversations/:conversationId/notes/:noteId — remove a note (workspace-scoped). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string; noteId: string }> }
) {
  const { noteId } = await params;
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { error } = await supabase
    .from("conversation_notes")
    .delete()
    .eq("id", noteId)
    .eq("workspace_id", auth.workspaceId);

  if (error) return NextResponse.json({ error: "Failed to delete note" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { authorizeApiV1 } from "@/lib/api-auth";

async function assertConversation(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  workspaceId: string
) {
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("workspace_id", workspaceId)
    .single();
  return !!data;
}

/** GET /api/v1/conversations/:conversationId/notes — internal notes (oldest first). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  if (!(await assertConversation(supabase, conversationId, auth.workspaceId)))
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("conversation_notes")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: "Failed to load notes" }, { status: 500 });
  return NextResponse.json({ data });
}

/** POST /api/v1/conversations/:conversationId/notes — add an internal note. Body: { content }. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;
  if (!auth.userId) return NextResponse.json({ error: "Notes require a user session" }, { status: 403 });

  if (!(await assertConversation(supabase, conversationId, auth.workspaceId)))
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) return NextResponse.json({ error: "content is required" }, { status: 400 });
  if (content.length > 10000) return NextResponse.json({ error: "Note is too long" }, { status: 400 });

  const { data, error } = await supabase
    .from("conversation_notes")
    .insert({
      conversation_id: conversationId,
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      content,
    })
    .select()
    .single();

  if (error || !data) return NextResponse.json({ error: "Failed to add note" }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/** GET /api/v1/saved-replies — list the workspace's canned replies (newest first). */
export async function GET(request: NextRequest) {
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data, error } = await supabase
    .from("saved_replies")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "Failed to load saved replies" }, { status: 500 });
  return NextResponse.json({ data });
}

/** POST /api/v1/saved-replies — create a canned reply. Body: { title, content, shortcut? }. */
export async function POST(request: NextRequest) {
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const shortcut = typeof body?.shortcut === "string" ? body.shortcut.trim() : "";
  if (!title || !content) {
    return NextResponse.json({ error: "title and content are required" }, { status: 400 });
  }
  if (title.length > 200 || content.length > 10000 || shortcut.length > 50) {
    return NextResponse.json({ error: "Field exceeds maximum length" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_replies")
    .insert({
      workspace_id: auth.workspaceId,
      title,
      content,
      shortcut: shortcut || null,
      created_by: auth.userId,
    })
    .select()
    .single();

  if (error || !data) return NextResponse.json({ error: "Failed to create saved reply" }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

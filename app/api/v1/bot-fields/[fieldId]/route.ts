import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/**
 * PUT /api/v1/bot-fields/:fieldId — update name/value/description (workspace-scoped).
 * The slug is immutable after creation (referenced in flows as {{bot.slug}}).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ fieldId: string }> }
) {
  const { fieldId } = await params;
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const update: { name?: string; value?: string; description?: string | null } = {};

  if (body?.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 200) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    update.name = name;
  }
  if (body?.value !== undefined) {
    if (typeof body.value !== "string" || body.value.length > 10000)
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    update.value = body.value;
  }
  if (body?.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string")
      return NextResponse.json({ error: "Invalid description" }, { status: 400 });
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length > 500) return NextResponse.json({ error: "Invalid description" }, { status: 400 });
    update.description = description || null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("bot_fields")
    .update(update)
    .eq("id", fieldId)
    .eq("workspace_id", auth.workspaceId)
    .select()
    .single();

  if (error || !data) return NextResponse.json({ error: "Bot field not found" }, { status: 404 });
  return NextResponse.json(data);
}

/** DELETE /api/v1/bot-fields/:fieldId — delete (workspace-scoped). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ fieldId: string }> }
) {
  const { fieldId } = await params;
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { error } = await supabase
    .from("bot_fields")
    .delete()
    .eq("id", fieldId)
    .eq("workspace_id", auth.workspaceId);

  if (error) return NextResponse.json({ error: "Failed to delete bot field" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

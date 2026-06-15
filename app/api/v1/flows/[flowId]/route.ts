import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data: flow, error } = await supabase
    .from("flows")
    .select("*, triggers(*)")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (error || !flow)
    return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  return NextResponse.json(flow);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json();

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.description !== undefined) update.description = body.description;
  if (body.nodes !== undefined) update.nodes = body.nodes;
  if (body.edges !== undefined) update.edges = body.edges;
  if (body.viewport !== undefined) update.viewport = body.viewport;

  const { data: flow, error } = await supabase
    .from("flows")
    .update(update)
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .select("id, name, status, updated_at")
    .maybeSingle();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!flow)
    return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  return NextResponse.json(flow);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { error } = await supabase
    .from("flows")
    .delete()
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

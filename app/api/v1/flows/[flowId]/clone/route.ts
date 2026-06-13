import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateRequest } from "@/lib/api-auth";

/**
 * POST /api/v1/flows/:flowId/clone
 * Duplicate a flow as a new draft (triggers copied but left inactive).
 * Scoped to the caller's active workspace.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { data: source } = await supabase
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (!source) return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name.trim() ? body.name : `${source.name} (copy)`;

  const { data: cloned, error } = await supabase
    .from("flows")
    .insert({
      workspace_id: auth.workspaceId,
      name,
      description: source.description,
      status: "draft",
      nodes: source.nodes,
      edges: source.edges,
      viewport: source.viewport,
      version: 1,
    })
    .select()
    .single();

  if (error || !cloned)
    return NextResponse.json({ error: "Failed to clone flow" }, { status: 500 });

  // Copy triggers onto the new flow, always inactive to avoid conflicts.
  const { data: triggers } = await supabase
    .from("triggers")
    .select("channel_id, type, config, priority")
    .eq("flow_id", flowId);

  if (triggers && triggers.length > 0) {
    await supabase.from("triggers").insert(
      triggers.map((t) => ({
        flow_id: cloned.id,
        channel_id: t.channel_id,
        type: t.type,
        config: t.config,
        priority: t.priority,
        is_active: false,
      }))
    );
  }

  return NextResponse.json(cloned, { status: 201 });
}

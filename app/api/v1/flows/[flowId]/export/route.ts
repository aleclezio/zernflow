import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/**
 * GET /api/v1/flows/:flowId/export
 * Download a flow as a portable `.zernflow.json` (no workspace/flow ids — those
 * are assigned on import). Scoped to the caller's active workspace; RLS backstops.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data: flow } = await supabase
    .from("flows")
    .select("name, description, nodes, edges, viewport, triggers(type, config, priority, is_active)")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  const exportData = {
    _format: "zernflow-v1",
    _exportedAt: new Date().toISOString(),
    name: flow.name,
    description: flow.description,
    nodes: flow.nodes,
    edges: flow.edges,
    viewport: flow.viewport,
    triggers: flow.triggers ?? [],
  };

  const filename = `${flow.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.zernflow.json`;

  return new NextResponse(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

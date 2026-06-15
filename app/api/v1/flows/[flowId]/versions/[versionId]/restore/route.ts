import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string; versionId: string }> }
) {
  const { flowId, versionId } = await params;
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  // flow_versions has no workspace_id; under API-key auth the service client
  // bypasses RLS, so verify the parent flow belongs to the caller's workspace
  // BEFORE reading any version (else another tenant's flow design leaks/restores).
  const { data: flow } = await supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();

  if (!flow)
    return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  // Get the version (scoped to the now-verified flow)
  const { data: version, error: vErr } = await supabase
    .from("flow_versions")
    .select("nodes, edges, viewport")
    .eq("id", versionId)
    .eq("flow_id", flowId)
    .single();

  if (vErr || !version)
    return NextResponse.json({ error: "Version not found" }, { status: 404 });

  // Restore: copy nodes/edges/viewport back, set status to draft
  const { error } = await supabase
    .from("flows")
    .update({
      nodes: version.nodes,
      edges: version.edges,
      viewport: version.viewport,
      status: "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

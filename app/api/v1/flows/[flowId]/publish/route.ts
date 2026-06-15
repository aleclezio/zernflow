import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  // Get current flow (workspace-scoped: under API-key auth the service client
  // bypasses RLS, so this .eq is the only tenant boundary).
  const { data: flow, error } = await supabase
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (error || !flow)
    return NextResponse.json(
      { error: error?.message || "Flow not found" },
      { status: 404 }
    );

  // Update flow status to published and increment version
  const newVersion = flow.version + 1;
  await supabase
    .from("flows")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      version: newVersion,
    })
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId);

  // Save version snapshot (published_by is null for API-key callers — no user identity)
  await supabase.from("flow_versions").insert({
    flow_id: flowId,
    version: newVersion,
    nodes: flow.nodes,
    edges: flow.edges,
    viewport: flow.viewport,
    name: flow.name,
    published_by: auth.userId,
  });

  // Activate all triggers for this (already workspace-verified) flow
  await supabase
    .from("triggers")
    .update({ is_active: true })
    .eq("flow_id", flowId);

  return NextResponse.json({ ...flow, version: newVersion });
}

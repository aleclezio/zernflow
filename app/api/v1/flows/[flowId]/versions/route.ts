import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const gate = await authorizeApiV1(request, "read");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  // flow_versions has no workspace_id of its own; under API-key auth the service
  // client bypasses RLS, so verify the parent flow belongs to the caller's
  // workspace BEFORE listing its versions (else any flowId's history leaks).
  const { data: flow } = await supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();

  if (!flow)
    return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  const { data: versions, error } = await supabase
    .from("flow_versions")
    .select("id, version, name, published_by, created_at")
    .eq("flow_id", flowId)
    .order("version", { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(versions || []);
}

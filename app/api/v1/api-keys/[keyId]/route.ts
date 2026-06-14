import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceAdmin } from "@/lib/api-auth";

/** DELETE /api/v1/api-keys/:keyId — revoke a key (immediately stops authenticating). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> }
) {
  const { keyId } = await params;
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data, error } = await supabase
    .from("api_keys")
    .delete()
    .eq("id", keyId)
    .eq("workspace_id", auth.workspaceId)
    .select("id");

  if (error) return NextResponse.json({ error: "Failed to revoke API key" }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const gate = await authorizeApiV1(request, "read");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data: channels, error } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(channels);
}

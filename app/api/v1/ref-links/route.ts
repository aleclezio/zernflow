import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateRequest } from "@/lib/api-auth";
import crypto from "crypto";

/** Random 8-hex-char slug for the public ref-link URL. */
function generateSlug(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** GET /api/v1/ref-links — list the workspace's ref links (newest first), with flow name/status. */
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ref_links")
    .select("*, flows(name, status)")
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "Failed to load ref links" }, { status: 500 });
  return NextResponse.json({ data });
}

/** POST /api/v1/ref-links — create a ref link. Body: { name, flowId, channelId? }. */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const flowId = typeof body?.flowId === "string" ? body.flowId : "";
  const channelId = typeof body?.channelId === "string" && body.channelId ? body.channelId : null;
  if (!name || !flowId) {
    return NextResponse.json({ error: "name and flowId are required" }, { status: 400 });
  }
  if (name.length > 200) {
    return NextResponse.json({ error: "name exceeds maximum length" }, { status: 400 });
  }

  const supabase = await createClient();

  // The flow (and channel, if given) must belong to the caller's workspace — a
  // foreign key alone only proves existence, not ownership, so a ref link could
  // otherwise reference another tenant's flow/channel.
  const { data: flow } = await supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .single();
  if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  if (channelId) {
    const { data: channel } = await supabase
      .from("channels")
      .select("id")
      .eq("id", channelId)
      .eq("workspace_id", auth.workspaceId)
      .single();
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("ref_links")
    .insert({
      workspace_id: auth.workspaceId,
      flow_id: flowId,
      channel_id: channelId,
      name,
      slug: generateSlug(),
    })
    .select("*, flows(name, status)")
    .single();

  if (error || !data) return NextResponse.json({ error: "Failed to create ref link" }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

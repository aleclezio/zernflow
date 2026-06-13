import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateRequest } from "@/lib/api-auth";
import type { Json } from "@/lib/types/database";
import type { TriggerType } from "@/lib/types/database";

interface ImportedTrigger {
  type?: string;
  config?: Json;
  priority?: number;
}

/**
 * POST /api/v1/flows/import
 * Create a new draft flow from a portable `.zernflow-v1` export. Triggers are
 * imported inactive and without a channel (the user re-assigns). Active-workspace scoped.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || body._format !== "zernflow-v1") {
    return NextResponse.json(
      { error: "Invalid format. Expected a ZernFlow export file (zernflow-v1)." },
      { status: 400 }
    );
  }
  if (!body.nodes || !body.edges) {
    return NextResponse.json(
      { error: "Invalid export: missing nodes or edges." },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { data: flow, error } = await supabase
    .from("flows")
    .insert({
      workspace_id: auth.workspaceId,
      name: typeof body.name === "string" ? body.name : "Imported Flow",
      description: body.description ?? null,
      status: "draft",
      nodes: body.nodes,
      edges: body.edges,
      viewport: body.viewport ?? null,
      version: 1,
    })
    .select()
    .single();

  if (error || !flow)
    return NextResponse.json({ error: "Failed to import flow" }, { status: 500 });

  if (Array.isArray(body.triggers) && body.triggers.length > 0) {
    await supabase.from("triggers").insert(
      (body.triggers as ImportedTrigger[]).map((t) => ({
        flow_id: flow.id,
        channel_id: null,
        type: (t.type ?? "keyword") as TriggerType,
        config: t.config ?? {},
        priority: typeof t.priority === "number" ? t.priority : 0,
        is_active: false,
      }))
    );
  }

  return NextResponse.json(flow, { status: 201 });
}

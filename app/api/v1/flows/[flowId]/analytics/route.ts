import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateRequest } from "@/lib/api-auth";

/**
 * GET /api/v1/flows/:flowId/analytics?from=&to=
 * Per-node execution counts + a flow-level funnel summary, aggregated from the
 * analytics_events the engine already records. Active-workspace scoped.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { data: flow } = await supabase
    .from("flows")
    .select("id")
    .eq("id", flowId)
    .eq("workspace_id", auth.workspaceId)
    .single();
  if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });

  const url = new URL(request.url);
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");

  let query = supabase
    .from("analytics_events")
    .select("metadata")
    .eq("flow_id", flowId)
    .eq("event_type", "node_executed");
  if (fromDate) query = query.gte("created_at", fromDate);
  if (toDate) query = query.lte("created_at", toDate);

  const { data: events, error } = await query;
  if (error) return NextResponse.json({ error: "Failed to load analytics" }, { status: 500 });

  const nodeCounts: Record<string, { executions: number; nodeType: string }> = {};
  for (const event of events ?? []) {
    const meta = event.metadata as { nodeId?: string; nodeType?: string } | null;
    if (meta?.nodeId) {
      if (!nodeCounts[meta.nodeId]) {
        nodeCounts[meta.nodeId] = { executions: 0, nodeType: meta.nodeType ?? "unknown" };
      }
      nodeCounts[meta.nodeId].executions++;
    }
  }

  const countQuery = (eventType: string) => {
    let q = supabase
      .from("analytics_events")
      .select("id", { count: "exact", head: true })
      .eq("flow_id", flowId)
      .eq("event_type", eventType);
    if (fromDate) q = q.gte("created_at", fromDate);
    if (toDate) q = q.lte("created_at", toDate);
    return q;
  };

  const [starts, completions, sent, failed] = await Promise.all([
    countQuery("flow_started"),
    countQuery("flow_completed"),
    countQuery("message_sent"),
    countQuery("message_failed"),
  ]);

  return NextResponse.json({
    flowId,
    summary: {
      starts: starts.count ?? 0,
      completions: completions.count ?? 0,
      dropOffRate: starts.count
        ? Math.round((1 - (completions.count ?? 0) / starts.count) * 100)
        : 0,
      messagesSent: sent.count ?? 0,
      messagesFailed: failed.count ?? 0,
    },
    nodes: nodeCounts,
  });
}

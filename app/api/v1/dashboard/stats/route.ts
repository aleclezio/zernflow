import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/**
 * GET /api/v1/dashboard/stats
 * Aggregated dashboard stats for the caller's active workspace (counts run in
 * parallel; recent-activity feed from analytics_events).
 */
export async function GET(request: NextRequest) {
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const workspaceId = auth.workspaceId;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    totalContacts,
    newContactsThisWeek,
    activeConversations,
    messagesSentThisWeek,
    activeFlows,
    recentActivity,
  ] = await Promise.all([
    supabase.from("contacts").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", sevenDaysAgo),
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "open"),
    supabase
      .from("analytics_events")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("event_type", "message_sent")
      .gte("created_at", sevenDaysAgo),
    supabase
      .from("flows")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "published"),
    supabase
      .from("analytics_events")
      .select("event_type, metadata, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return NextResponse.json({
    totalContacts: totalContacts.count ?? 0,
    newContactsThisWeek: newContactsThisWeek.count ?? 0,
    activeConversations: activeConversations.count ?? 0,
    messagesSentThisWeek: messagesSentThisWeek.count ?? 0,
    activeFlows: activeFlows.count ?? 0,
    recentActivity: recentActivity.data ?? [],
  });
}

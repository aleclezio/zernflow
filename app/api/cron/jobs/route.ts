import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeFlow } from "@/lib/flow-engine/engine";
import { requireCronAuth } from "@/lib/cron-auth";
import type { Json } from "@/lib/types/database";

/**
 * Cron job handler that processes scheduled jobs.
 * Call via external cron every 10-30 seconds with:
 *   Authorization: Bearer $CRON_SECRET
 */
export async function GET(request: NextRequest) {
  if (!requireCronAuth(request)) {
    const { logSecurityEvent } = await import("@/lib/security-events");
    await logSecurityEvent("cron_auth_failed", null, { route: "jobs" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServiceClient();

  // Webhook dedupe retention: ids older than 7 days can never be replayed by
  // Zernio (max retry window ~51h), so drop them to keep the table bounded.
  await supabase
    .from("webhook_events")
    .delete()
    .lt("received_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  // Send-attempt observability retention: keep 90 days, then drop so the table
  // stays bounded (rows are tiny; this caps it permanently).
  await supabase
    .from("send_attempts")
    .delete()
    .lt("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());

  // Pick up pending jobs that are due
  const { data: jobs, error } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("run_at", new Date().toISOString())
    .order("run_at", { ascending: true })
    .limit(20);

  if (error || !jobs) {
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    // Mark as processing
    await supabase
      .from("scheduled_jobs")
      .update({ status: "processing", attempts: job.attempts + 1 })
      .eq("id", job.id)
      .eq("status", "pending"); // Optimistic lock

    try {
      await processJob(supabase, job);
      await supabase
        .from("scheduled_jobs")
        .update({ status: "completed" })
        .eq("id", job.id);
      processed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const maxAttempts = 3;

      if (job.attempts + 1 >= maxAttempts) {
        await supabase
          .from("scheduled_jobs")
          .update({ status: "failed", last_error: errorMessage })
          .eq("id", job.id);
      } else {
        // Retry with backoff
        const backoffMs = Math.pow(2, job.attempts + 1) * 5000;
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: retryAt,
            last_error: errorMessage,
          })
          .eq("id", job.id);
      }
      failed++;
    }
  }

  return NextResponse.json({ processed, failed, total: jobs.length });
}

async function processJob(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  job: { type: string; payload: Json }
) {
  switch (job.type) {
    case "resume_flow": {
      const payload = job.payload as { sessionId: string };

      // Check if session is still active
      const { data: session } = await supabase
        .from("flow_sessions")
        .select("*")
        .eq("id", payload.sessionId)
        .eq("status", "active")
        .single();

      if (!session) return; // Session was cancelled/completed

      // Re-derive EVERYTHING from owned rows — the payload is never trusted
      // beyond the session id (defense in depth on top of service-role-only
      // RLS for scheduled_jobs).
      const { data: flow } = await supabase
        .from("flows")
        .select("workspace_id")
        .eq("id", session.flow_id)
        .single();
      if (!flow) return;

      const { data: channel } = await supabase
        .from("channels")
        .select("workspace_id, late_account_id")
        .eq("id", session.channel_id)
        .single();
      if (!channel || channel.workspace_id !== flow.workspace_id) {
        console.error(`[anomaly] resume_flow: channel/flow workspace mismatch for session ${session.id}`);
        return;
      }

      const { data: conversation } = await supabase
        .from("conversations")
        .select("id, late_conversation_id, workspace_id")
        .eq("channel_id", session.channel_id)
        .eq("contact_id", session.contact_id)
        .maybeSingle();
      if (!conversation || conversation.workspace_id !== flow.workspace_id) {
        console.error(`[anomaly] resume_flow: conversation workspace mismatch for session ${session.id}`);
        return;
      }

      await executeFlow(supabase, {
        triggerId: "",
        flowId: session.flow_id,
        channelId: session.channel_id,
        contactId: session.contact_id,
        conversationId: conversation.id,
        workspaceId: flow.workspace_id,
        lateConversationId: conversation.late_conversation_id || undefined,
        lateAccountId: channel.late_account_id || undefined,
        incomingMessage: {},
      });
      break;
    }

    case "send_broadcast": {
      const payload = job.payload as {
        broadcastId: string;
        recipientId: string;
      };

      // Process individual broadcast recipient
      const { data: recipient } = await supabase
        .from("broadcast_recipients")
        .select("*, contacts(*), channels(*), broadcasts(*)")
        .eq("id", payload.recipientId)
        .single();

      if (!recipient || recipient.status !== "pending") return;

      // Get workspace API key
      const broadcast = recipient.broadcasts as { workspace_id: string } | null;
      if (!broadcast) return;

      const { getZernioKey } = await import("@/lib/workspace-keys");
      const apiKey = await getZernioKey(supabase, broadcast.workspace_id);
      if (!apiKey) return;

      const { createZernioClient } = await import("@/lib/zernio-client");
      const zernio = createZernioClient(apiKey);

      const channel = recipient.channels as { late_account_id: string } | null;
      if (!channel) return;

      // Get the conversation for this contact+channel (need late_conversation_id)
      const { data: conv } = await supabase
        .from("conversations")
        .select("late_conversation_id")
        .eq("contact_id", recipient.contact_id)
        .eq("channel_id", recipient.channel_id)
        .single();

      if (!conv?.late_conversation_id) return;

      const broadcastData = recipient.broadcasts as { message_content: { text?: string } } | null;
      const messageContent = broadcastData?.message_content;

      try {
        await zernio.messages.sendInboxMessage({
          path: { conversationId: conv.late_conversation_id },
          body: { accountId: channel.late_account_id, message: messageContent?.text || "" },
        });

        await supabase
          .from("broadcast_recipients")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", payload.recipientId);

        // Increment broadcast sent count
        await supabase.rpc("increment_broadcast_sent", {
          b_id: payload.broadcastId,
        });
      } catch (err) {
        await supabase
          .from("broadcast_recipients")
          .update({
            status: "failed",
            error_message: err instanceof Error ? err.message : String(err),
          })
          .eq("id", payload.recipientId);

        await supabase.rpc("increment_broadcast_failed", {
          b_id: payload.broadcastId,
        });
      }

      // Check if all recipients are done (no more "pending")
      const { count } = await supabase
        .from("broadcast_recipients")
        .select("id", { count: "exact", head: true })
        .eq("broadcast_id", payload.broadcastId)
        .eq("status", "pending");

      if (count === 0) {
        await supabase
          .from("broadcasts")
          .update({ status: "completed" })
          .eq("id", payload.broadcastId)
          .eq("status", "sending");
      }
      break;
    }

    default:
      console.warn(`Unknown job type: ${job.type}`);
  }
}

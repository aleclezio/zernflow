import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { scheduleBroadcastDelivery } from "@/lib/scheduler";
import { requireCronAuth } from "@/lib/cron-auth";
import { resolveContacts, type SegmentFilter } from "@/lib/broadcast-segments";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Cron: process scheduled broadcasts that are due (status='scheduled',
 * scheduled_for <= now()). For each, resolves the segment filter into contacts,
 * creates broadcast_recipients, and schedules delivery jobs via
 * scheduleBroadcastDelivery — the same flow as the manual send route (shared
 * segment resolution in lib/broadcast-segments.ts).
 *
 * Call every minute with: Authorization: Bearer $CRON_SECRET
 */
export async function GET(request: NextRequest) {
  if (!requireCronAuth(request)) {
    const { logSecurityEvent } = await import("@/lib/security-events");
    await logSecurityEvent("cron_auth_failed", null, { route: "broadcasts" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServiceClient();

  // Find broadcasts that are scheduled and due (limit 5 per tick to avoid timeouts)
  const { data: broadcasts, error: fetchError } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(5);

  if (fetchError) {
    console.error("Failed to fetch scheduled broadcasts:", fetchError);
    return NextResponse.json({ error: "Failed to fetch broadcasts" }, { status: 500 });
  }

  if (!broadcasts || broadcasts.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  let processed = 0;
  let failed = 0;

  for (const broadcast of broadcasts) {
    try {
      // Mark as sending immediately to prevent double-processing (optimistic lock on status)
      const { data: updated } = await supabase
        .from("broadcasts")
        .update({ status: "sending" })
        .eq("id", broadcast.id)
        .eq("status", "scheduled")
        .select("id")
        .single();

      // If update returned nothing, another process already picked it up
      if (!updated) {
        continue;
      }

      // Validate message content
      const messageContent = broadcast.message_content as { text?: string } | null;
      if (!messageContent?.text?.trim()) {
        console.error(`Broadcast ${broadcast.id} has no message content, marking as cancelled`);
        await supabase
          .from("broadcasts")
          .update({ status: "cancelled" })
          .eq("id", broadcast.id);
        processed++;
        continue;
      }

      // Resolve contacts from segment filter (shared with the manual send route)
      const filter = broadcast.segment_filter as unknown as SegmentFilter | null;
      const contactIds = await resolveContacts(supabase, broadcast.workspace_id, filter);

      if (contactIds.length === 0) {
        console.warn(`Broadcast ${broadcast.id} matched 0 contacts, marking as completed`);
        await supabase
          .from("broadcasts")
          .update({ status: "completed", total_recipients: 0 })
          .eq("id", broadcast.id);
        processed++;
        continue;
      }

      // For each contact, find their first active channel link (via contact_channels)
      const { data: contactChannels } = await supabase
        .from("contact_channels")
        .select("contact_id, channel_id")
        .in("contact_id", contactIds);

      if (!contactChannels?.length) {
        console.warn(`Broadcast ${broadcast.id}: no contacts have channel connections, marking as completed`);
        await supabase
          .from("broadcasts")
          .update({ status: "completed", total_recipients: 0 })
          .eq("id", broadcast.id);
        processed++;
        continue;
      }

      // Deduplicate: one recipient per contact (first channel found)
      const seen = new Set<string>();
      const recipientPairs: { contactId: string; channelId: string }[] = [];
      for (const cc of contactChannels) {
        if (!seen.has(cc.contact_id)) {
          seen.add(cc.contact_id);
          recipientPairs.push({ contactId: cc.contact_id, channelId: cc.channel_id });
        }
      }

      // Create broadcast_recipients rows
      const recipientRows = recipientPairs.map((r) => ({
        broadcast_id: broadcast.id,
        contact_id: r.contactId,
        channel_id: r.channelId,
        status: "pending",
      }));

      // Insert in batches of 500
      const recipientIds: string[] = [];
      for (let i = 0; i < recipientRows.length; i += 500) {
        const batch = recipientRows.slice(i, i + 500);
        const { data: inserted, error: insertErr } = await supabase
          .from("broadcast_recipients")
          .insert(batch)
          .select("id");

        if (insertErr) {
          console.error(`Broadcast ${broadcast.id}: failed to insert recipients:`, insertErr);
          throw new Error("Failed to create recipients");
        }

        if (inserted) {
          recipientIds.push(...inserted.map((r) => r.id));
        }
      }

      if (recipientIds.length === 0) {
        throw new Error("Failed to create broadcast recipients");
      }

      // Schedule delivery jobs (creates scheduled_jobs with 100ms spacing,
      // picked up by /api/cron/jobs)
      await scheduleBroadcastDelivery(supabase, broadcast.id, recipientIds);

      processed++;
    } catch (error) {
      console.error(`Failed to process broadcast ${broadcast.id}:`, error);
      // Revert to scheduled so it can be retried on the next tick
      await supabase
        .from("broadcasts")
        .update({ status: "scheduled" })
        .eq("id", broadcast.id);
      failed++;
    }
  }

  return NextResponse.json({ processed, failed, total: broadcasts.length });
}

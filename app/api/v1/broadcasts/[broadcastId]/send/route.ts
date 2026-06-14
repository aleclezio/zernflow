import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { scheduleBroadcastDelivery } from "@/lib/scheduler";
import { resolveContacts, type SegmentFilter } from "@/lib/broadcast-segments";
import type { Json } from "@/lib/types/database";

/**
 * POST /api/v1/broadcasts/:broadcastId/send
 *
 * Resolves the broadcast's segment filter into contacts,
 * creates broadcast_recipients, and schedules delivery jobs.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ broadcastId: string }> }
) {
  const { broadcastId } = await params;
  const supabase = await createClient();

  // Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  // Fetch the broadcast
  const { data: broadcast, error: broadcastErr } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("id", broadcastId)
    .eq("workspace_id", membership.workspace_id)
    .single();

  if (broadcastErr || !broadcast) {
    return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
  }

  if (broadcast.status !== "draft" && broadcast.status !== "scheduled") {
    return NextResponse.json(
      { error: `Cannot send broadcast with status "${broadcast.status}"` },
      { status: 400 }
    );
  }

  // Allow overriding message content from the request body
  let messageContent = broadcast.message_content as { text?: string };
  try {
    const body = await request.json();
    if (body.messageContent) {
      messageContent = body.messageContent;
      // Update the broadcast with the message content
      await supabase
        .from("broadcasts")
        .update({ message_content: messageContent as unknown as Json })
        .eq("id", broadcastId);
    }
  } catch {
    // No body or invalid JSON, use existing message_content
  }

  if (!messageContent?.text?.trim()) {
    return NextResponse.json(
      { error: "Message content is required. Set message_content.text on the broadcast." },
      { status: 400 }
    );
  }

  // Resolve contacts from segment filter
  const filter = broadcast.segment_filter as unknown as SegmentFilter | null;
  const contactIds = await resolveContacts(
    supabase,
    membership.workspace_id,
    filter
  );

  if (contactIds.length === 0) {
    return NextResponse.json(
      { error: "No contacts match the segment filter" },
      { status: 400 }
    );
  }

  // For each contact, find their first active channel link (via contact_channels)
  const { data: contactChannels } = await supabase
    .from("contact_channels")
    .select("contact_id, channel_id")
    .in("contact_id", contactIds);

  if (!contactChannels?.length) {
    return NextResponse.json(
      { error: "No contacts have active channel connections" },
      { status: 400 }
    );
  }

  // Deduplicate: one recipient per contact (first channel found)
  const seen = new Set<string>();
  const recipientPairs: { contactId: string; channelId: string }[] = [];
  for (const cc of contactChannels) {
    if (!seen.has(cc.contact_id)) {
      seen.add(cc.contact_id);
      recipientPairs.push({
        contactId: cc.contact_id,
        channelId: cc.channel_id,
      });
    }
  }

  // Create broadcast_recipients
  const recipientRows = recipientPairs.map((r) => ({
    broadcast_id: broadcastId,
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
      console.error("Failed to insert broadcast recipients:", insertErr);
      return NextResponse.json(
        { error: `Failed to create recipients: ${insertErr.message}` },
        { status: 500 }
      );
    }

    if (inserted) {
      recipientIds.push(...inserted.map((r) => r.id));
    }
  }

  if (recipientIds.length === 0) {
    return NextResponse.json(
      { error: "Failed to create broadcast recipients" },
      { status: 500 }
    );
  }

  // Schedule delivery. scheduled_jobs is service-role only (tenant lockdown);
  // this route has already verified auth + workspace ownership above.
  await scheduleBroadcastDelivery(await createServiceClient(), broadcastId, recipientIds);

  return NextResponse.json({
    broadcastId,
    totalRecipients: recipientIds.length,
    status: "sending",
  });
}

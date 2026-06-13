import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeFlow } from "@/lib/flow-engine/engine";
import { matchTrigger } from "@/lib/flow-engine/trigger-matcher";
import { findWorkspaceByWebhookToken } from "@/lib/workspace-keys";
import { pickSignatureHeader, resolveEventId, sha256Hex, verifySignature } from "@/lib/webhook-verify";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent } from "@/lib/security-events";
import { matchCommentTrigger, type CommentTrigger } from "@/lib/flow-engine/comment-matcher";

/**
 * POST /api/webhooks/zernio/[token]
 *
 * Per-workspace capability-URL webhook endpoint. Ordering is load-bearing:
 *
 *   1. sha256(token) -> workspace lookup            (unknown -> 404)
 *   2. raw body + signature header                  (canonical wins)
 *   3. workspace webhook secret (MANDATORY)         (absent -> 401)
 *   4. length-check + timingSafeEqual               (mismatch -> 401)
 *   5. ONLY THEN JSON.parse                         (invalid -> 400)
 *   6. event filter + outbound skip                 (-> 200 skipped)
 *   7. dedupe INSERT-before-process                 (replay -> 200 duplicate)
 *   8. workspace-scoped channel lookup              (miss -> 200 skipped,
 *      never 404: Zernio auto-disables a webhook after 10 failures)
 *   9. process (contact/conversation/flows)
 *
 * Because the dedupe row commits before processing, Zernio's at-least-once
 * retries of a slow delivery no-op instead of double-executing flows.
 */

interface WebhookPayload {
  id?: string;
  event: string;
  message: {
    id: string;
    conversationId: string;
    platform: string;
    platformMessageId: string;
    direction: string;
    text: string | null;
    attachments: Array<{ type: string; url: string; payload?: string }>;
    sender: {
      id: string;
      name: string;
      username: string | null;
      picture: string | null;
    };
    sentAt: string;
    isRead: boolean;
  };
  conversation: {
    id: string;
    platformConversationId: string | null;
    participantId: string;
    participantName: string;
    participantUsername: string | null;
    participantPicture: string | null;
    status: string;
  };
  account: {
    id: string;
    platform: string;
    username: string;
    displayName: string;
  };
  metadata?: {
    quickReplyPayload?: string;
    callbackData?: string;
    postbackPayload?: string;
    postbackTitle?: string;
  };
  timestamp: string;
}

interface CommentWebhookPayload {
  id?: string;
  event: "comment.received";
  comment: {
    id: string;
    postId: string | null;
    platformPostId: string;
    platform: string;
    text: string;
    author: { id: string; username?: string; name?: string; picture?: string | null };
    createdAt: string;
    isReply: boolean;
    parentCommentId: string | null;
  };
  post: { id: string | null; platformPostId: string };
  account: { id: string; platform: string; username: string };
  timestamp: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const supabase = await createServiceClient();

  // 1. Capability-URL token -> workspace. The only pre-auth DB work.
  const ws = await findWorkspaceByWebhookToken(supabase, sha256Hex(token));
  if (!ws) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!checkRateLimit(`webhook:${ws.workspaceId}`, 120, 60_000)) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  // 2-4. Verify BEFORE parsing anything.
  const rawBody = await request.text();
  const signature = pickSignatureHeader(request.headers);
  if (!ws.webhookSecret || !signature || !verifySignature(rawBody, signature, ws.webhookSecret)) {
    await logSecurityEvent("webhook_sig_rejected", ws.workspaceId, {
      reason: !ws.webhookSecret ? "no_secret" : !signature ? "no_signature" : "bad_signature",
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 5. Parse only after authentication.
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 6. Event filter. We process inbound DMs and inbound comments; our own
  // outbound messages and every other event type are acked + skipped.
  const isMessage =
    payload.event === "message.received" && payload.message?.direction !== "outbound";
  const isComment = payload.event === "comment.received";
  if (!isMessage && !isComment) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // 7. Dedupe: insert BEFORE processing; the insert is the gate.
  const { eventId, synthetic } = resolveEventId(request.headers, payload, rawBody);
  if (synthetic) {
    console.warn(
      `[anomaly] webhook: event without usable id for workspace ${ws.workspaceId} — using synthetic body hash`
    );
  }
  const { data: dedupeRow } = await supabase
    .from("webhook_events")
    .upsert(
      { workspace_id: ws.workspaceId, event_id: eventId, synthetic },
      { onConflict: "workspace_id,event_id", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();

  if (!dedupeRow) {
    await logSecurityEvent("webhook_replay", ws.workspaceId, { eventId });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // 8-9. Process; failures return 500 so Zernio retries, but the committed
  // dedupe row means a retry of a PARTIALLY processed event no-ops. That is
  // the at-most-once choice: better to drop one event than double-send DMs.
  try {
    const response = isComment
      ? await processCommentEvent(
          supabase,
          ws.workspaceId,
          payload as unknown as CommentWebhookPayload
        )
      : await processEvent(supabase, ws.workspaceId, payload);
    await supabase
      .from("webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", dedupeRow.id);
    return response;
  } catch (err) {
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function processEvent(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  workspaceId: string,
  payload: WebhookPayload
) {
  const { message: msg, conversation: conv, account, metadata } = payload;

  // Channel lookup is WORKSPACE-SCOPED: an account id can never route into
  // another tenant, whatever the payload claims.
  const { data: channel } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("late_account_id", account.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!channel) {
    return NextResponse.json({ ok: true, skipped: true, reason: "unknown_account" });
  }

  // Loop prevention: if the sender is another connected account in this
  // workspace, skip (both sides of a DM connected, e.g. during testing).
  if (msg.sender.username) {
    const { data: senderChannel } = await supabase
      .from("channels")
      .select("id")
      .eq("workspace_id", channel.workspace_id)
      .eq("username", msg.sender.username)
      .eq("is_active", true)
      .maybeSingle();

    if (senderChannel) {
      return NextResponse.json({ ok: true, skipped: true, reason: "sender_is_own_account" });
    }
  }

  // ── Upsert contact ───────────────────────────────────────────────────────

  const senderId = msg.sender.id;
  const senderName = msg.sender.name || msg.sender.username || senderId;

  let contactId: string;
  const { data: existingContactChannel } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", channel.id)
    .eq("platform_sender_id", senderId)
    .maybeSingle();

  if (existingContactChannel) {
    contactId = existingContactChannel.contact_id;
    await supabase
      .from("contacts")
      .update({ last_interaction_at: new Date().toISOString() })
      .eq("id", contactId);
  } else {
    const { data: newContact } = await supabase
      .from("contacts")
      .insert({
        workspace_id: channel.workspace_id,
        display_name: senderName,
        avatar_url: msg.sender.picture || null,
        last_interaction_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (!newContact) {
      return NextResponse.json({ error: "Failed to create contact" }, { status: 500 });
    }

    contactId = newContact.id;

    await supabase.from("contact_channels").insert({
      contact_id: contactId,
      channel_id: channel.id,
      platform_sender_id: senderId,
      platform_username: msg.sender.username || null,
    });

    await supabase.from("analytics_events").insert({
      workspace_id: channel.workspace_id,
      contact_id: contactId,
      event_type: "contact_created",
    });
  }

  // ── Upsert conversation ──────────────────────────────────────────────────

  const messagePreview = (msg.text || "").slice(0, 100);

  const { data: conversation } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contactId,
        platform: channel.platform,
        late_conversation_id: conv.id,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_message_preview: messagePreview,
        unread_count: 1,
      },
      { onConflict: "channel_id,contact_id" }
    )
    .select("id, is_automation_paused")
    .single();

  if (!conversation) {
    return NextResponse.json({ error: "Failed to upsert conversation" }, { status: 500 });
  }

  if (existingContactChannel) {
    await supabase
      .rpc("increment_unread", {
        conv_id: conversation.id,
        preview: messagePreview,
      })
      .then(() => {});
  }

  // Messages are stored by Zernio (source of truth) — no local insert needed.

  // ── Flow engine ───────────────────────────────────────────────────────────

  if (!conversation.is_automation_paused) {
    const incomingMessage = {
      text: msg.text || undefined,
      postbackPayload: metadata?.postbackPayload || undefined,
      quickReplyPayload: metadata?.quickReplyPayload || undefined,
      callbackData: metadata?.callbackData || undefined,
      sender: {
        id: msg.sender.id,
        name: msg.sender.name,
        username: msg.sender.username || undefined,
      },
    };

    const handled = await handleGlobalKeywords(
      supabase,
      channel.workspace_id,
      contactId,
      msg.text || undefined
    );

    if (!handled) {
      const trigger = await matchTrigger(supabase, channel.id, conversation.id, incomingMessage);
      if (trigger) {
        try {
          await executeFlow(supabase, {
            triggerId: trigger.id,
            flowId: trigger.flow_id,
            channelId: channel.id,
            contactId,
            conversationId: conversation.id,
            workspaceId: channel.workspace_id,
            incomingMessage,
            lateConversationId: conv.id,
            lateAccountId: account.id,
          });
        } catch (err) {
          console.error("Flow execution error:", err);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}

// ── Comments (comment.received → comment_keyword → private-reply DM) ─────────

async function processCommentEvent(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  workspaceId: string,
  payload: CommentWebhookPayload
) {
  const { comment, account } = payload;

  // Channel lookup is WORKSPACE-SCOPED — same tenant invariant as messages.
  const { data: channel } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("late_account_id", account.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!channel) {
    return NextResponse.json({ ok: true, skipped: true, reason: "unknown_account" });
  }

  // Loop guard: never act on a comment authored by one of this workspace's
  // own connected accounts (e.g. our own reply showing up as a comment).
  if (comment.author?.username) {
    const { data: ownChannel } = await supabase
      .from("channels")
      .select("id")
      .eq("workspace_id", channel.workspace_id)
      .eq("username", comment.author.username)
      .eq("is_active", true)
      .maybeSingle();
    if (ownChannel) {
      return NextResponse.json({ ok: true, skipped: true, reason: "author_is_own_account" });
    }
  }

  // Active comment_keyword triggers for this channel; matching is the tested
  // pure function in comment-matcher.ts (keyword + post-scope + exclude).
  const { data: triggerRows } = await supabase
    .from("triggers")
    .select("id, flow_id, channel_id, is_active, priority, config")
    .eq("channel_id", channel.id)
    .eq("type", "comment_keyword")
    .eq("is_active", true);

  const matched = matchCommentTrigger(
    comment.text,
    comment.platformPostId,
    (triggerRows ?? []) as unknown as CommentTrigger[]
  );

  const logBase = {
    channel_id: channel.id,
    workspace_id: channel.workspace_id,
    post_id: comment.platformPostId,
    platform_comment_id: comment.id,
    author_id: comment.author?.id || null,
    author_name: comment.author?.name || null,
    author_username: comment.author?.username || null,
    comment_text: comment.text,
  };

  if (!matched) {
    // comment_logs (channel_id, platform_comment_id) is unique → the upsert is
    // also the comment-level dedupe, on top of the webhook_events event dedupe.
    await supabase
      .from("comment_logs")
      .upsert(
        { ...logBase, matched_trigger_id: null, dm_sent: false, reply_sent: false },
        { onConflict: "channel_id,platform_comment_id" }
      );
    return NextResponse.json({ ok: true, matched: false });
  }

  // Upsert the commenter as a contact, scoped to this channel.
  const senderId = comment.author?.id || `comment_${comment.id}`;
  const senderName = comment.author?.name || comment.author?.username || senderId;

  let contactId: string;
  const { data: existing } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", channel.id)
    .eq("platform_sender_id", senderId)
    .maybeSingle();

  if (existing) {
    contactId = existing.contact_id;
    await supabase
      .from("contacts")
      .update({ last_interaction_at: new Date().toISOString() })
      .eq("id", contactId);
  } else {
    const { data: newContact } = await supabase
      .from("contacts")
      .insert({
        workspace_id: channel.workspace_id,
        display_name: senderName,
        avatar_url: comment.author?.picture || null,
        last_interaction_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (!newContact) {
      await supabase
        .from("comment_logs")
        .upsert(
          { ...logBase, matched_trigger_id: matched.id, dm_sent: false, reply_sent: false, error: "failed to create contact" },
          { onConflict: "channel_id,platform_comment_id" }
        );
      return NextResponse.json({ error: "Failed to create contact" }, { status: 500 });
    }

    contactId = newContact.id;
    await supabase.from("contact_channels").insert({
      contact_id: contactId,
      channel_id: channel.id,
      platform_sender_id: senderId,
      platform_username: comment.author?.username || null,
    });
  }

  // Conversation the private-reply DM will live in.
  const { data: conversation } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contactId,
        platform: channel.platform,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_message_preview: `[comment] ${(comment.text || "").slice(0, 80)}`,
      },
      { onConflict: "channel_id,contact_id" }
    )
    .select("id")
    .single();

  let dmSent = false;
  if (conversation) {
    try {
      // comment_id + post_id are REQUIRED by executePrivateReply for the
      // sendPrivateReplyToComment call — pass the platform ids explicitly.
      await executeFlow(supabase, {
        triggerId: matched.id,
        flowId: matched.flow_id,
        channelId: channel.id,
        contactId,
        conversationId: conversation.id,
        workspaceId: channel.workspace_id,
        incomingMessage: {
          text: comment.text,
          sender: {
            id: senderId,
            name: comment.author?.name,
            username: comment.author?.username || undefined,
          },
        },
        lateAccountId: account.id,
        variables: {
          comment_id: comment.id,
          post_id: comment.platformPostId,
          comment_text: comment.text,
          commenter_name: senderName,
        },
      });
      dmSent = true;
    } catch (err) {
      console.error("Comment flow execution error:", err);
    }
  }

  await supabase
    .from("comment_logs")
    .upsert(
      { ...logBase, matched_trigger_id: matched.id, dm_sent: dmSent, reply_sent: false },
      { onConflict: "channel_id,platform_comment_id" }
    );

  return NextResponse.json({ ok: true, matched: true });
}

// ── Global keywords ─────────────────────────────────────────────────────────

async function handleGlobalKeywords(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  workspaceId: string,
  contactId: string,
  text: string | undefined
): Promise<boolean> {
  if (!text) return false;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("global_keywords")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.global_keywords) return false;

  const keywords = workspace.global_keywords as Array<{
    keyword: string;
    action?: string;
    flowId?: string;
  }>;

  const normalizedText = text.toLowerCase().trim();

  for (const kw of keywords) {
    if (normalizedText === kw.keyword.toLowerCase()) {
      if (kw.action === "unsubscribe") {
        await supabase
          .from("contacts")
          .update({ is_subscribed: false })
          .eq("id", contactId);
        return true;
      }
      if (kw.action === "subscribe") {
        await supabase
          .from("contacts")
          .update({ is_subscribed: true })
          .eq("id", contactId);
        return true;
      }
      return false;
    }
  }

  return false;
}

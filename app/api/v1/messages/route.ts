import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";
import { createZernioClient } from "@/lib/zernio-client";
import { getZernioKey } from "@/lib/workspace-keys";
import { recordSendAttempt, classifySendError } from "@/lib/send-attempts";

/**
 * GET /api/v1/messages?conversationId=...
 *
 * Fetches messages from the Zernio API (source of truth) instead of a local mirror.
 */
export async function GET(request: NextRequest) {
  const gate = await authorizeApiV1(request, "read");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const conversationId = request.nextUrl.searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  // Look up the Zernio conversation ID and workspace API key. Workspace-scoped:
  // under API-key auth the service client bypasses RLS, so this .eq is the only
  // tenant boundary on the conversation lookup.
  const { data: conversation } = await supabase
    .from("conversations")
    .select("late_conversation_id, workspace_id, channels(late_account_id)")
    .eq("id", conversationId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (!conversation?.late_conversation_id) {
    return NextResponse.json({ error: "Conversation not found or missing Zernio ID" }, { status: 404 });
  }

  const apiKey = await getZernioKey(supabase, conversation.workspace_id);
  if (!apiKey) {
    return NextResponse.json({ error: "API key not configured" }, { status: 400 });
  }

  const channel = conversation.channels as { late_account_id: string } | null;
  if (!channel?.late_account_id) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  // Fetch messages from Zernio API
  try {
    const zernio = createZernioClient(apiKey);
    const res = await zernio.messages.getInboxConversationMessages({
      path: { conversationId: conversation.late_conversation_id },
      query: { accountId: channel.late_account_id },
    });

    // @zernio/node returns the page under `.messages` (GetInboxConversationMessagesResponse),
    // not `.data`. Keep `.data` as a defensive fallback for SDK drift.
    const zernioMessages = (res.data as any)?.messages ?? (res.data as any)?.data ?? [];

    // Map Zernio messages to the shape the inbox UI expects. The SDK emits
    // direction "incoming"/"outgoing" (NOT "inbound"/"outbound").
    const messages = zernioMessages.map((m: any) => ({
      id: m.id,
      conversation_id: conversationId,
      direction: m.direction === "outgoing" || m.direction === "outbound" ? "outbound" : "inbound",
      text: m.message ?? m.text ?? null,
      attachments: m.attachments?.length ? m.attachments : null,
      quick_reply_payload: null,
      postback_payload: null,
      callback_data: null,
      platform_message_id: m.platformMessageId ?? null,
      sent_by_flow_id: null,
      sent_by_node_id: null,
      sent_by_user_id: null,
      status: "sent",
      created_at: m.sentAt ?? m.createdAt ?? new Date().toISOString(),
    }));

    return NextResponse.json(messages);
  } catch (error) {
    console.error("Failed to fetch messages from Zernio API:", error);
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/messages
 *
 * Sends a message via Zernio API. No local message storage — Zernio is the source of truth.
 */
export async function POST(request: NextRequest) {
  const gate = await authorizeApiV1(request, "send");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json();
  const { conversationId, text } = body;

  if (!conversationId || !text) {
    return NextResponse.json(
      { error: "conversationId and text required" },
      { status: 400 }
    );
  }

  const textLength = typeof text === "string" ? text.length : null;

  // Get conversation with channel info. Workspace-scoped (service client bypasses
  // RLS under API-key auth, so this .eq is the tenant boundary).
  const { data: conversation } = await supabase
    .from("conversations")
    .select("*, channels(*)")
    .eq("id", conversationId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (!conversation) {
    await recordSendAttempt({
      workspaceId: auth.workspaceId, conversationId, lateConversationId: null,
      accountId: null, platform: null, outcome: "guard_no_conversation",
      httpStatus: 404, textLength,
    });
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  // How long after the contact's last inbound message this send was attempted —
  // makes the Instagram 24h-window question answer itself per attempt.
  const msSinceLastInbound = conversation.last_inbound_at
    ? Date.now() - new Date(conversation.last_inbound_at).getTime()
    : null;
  const platform = conversation.platform ?? null;

  if (!conversation.late_conversation_id) {
    await recordSendAttempt({
      workspaceId: auth.workspaceId, conversationId, lateConversationId: null,
      accountId: null, platform, outcome: "guard_no_late_id",
      httpStatus: 400, msSinceLastInbound, textLength,
    });
    return NextResponse.json(
      { error: "No Zernio conversation ID linked to this conversation" },
      { status: 400 }
    );
  }

  const channel = conversation.channels as { late_account_id: string } | null;
  if (!channel?.late_account_id) {
    await recordSendAttempt({
      workspaceId: auth.workspaceId, conversationId,
      lateConversationId: conversation.late_conversation_id,
      accountId: null, platform, outcome: "guard_no_channel",
      httpStatus: 404, msSinceLastInbound, textLength,
    });
    return NextResponse.json({ error: "Channel not found or missing Zernio account ID" }, { status: 404 });
  }

  const apiKey = await getZernioKey(supabase, conversation.workspace_id);
  if (!apiKey) {
    await recordSendAttempt({
      workspaceId: auth.workspaceId, conversationId,
      lateConversationId: conversation.late_conversation_id,
      accountId: channel.late_account_id, platform, outcome: "guard_no_key",
      httpStatus: 400, msSinceLastInbound, textLength,
    });
    return NextResponse.json({ error: "API key not configured" }, { status: 400 });
  }

  // Send via Zernio SDK — Zernio stores the message, no local insert needed
  try {
    const zernio = createZernioClient(apiKey);
    const res = await zernio.messages.sendInboxMessage({
      path: { conversationId: conversation.late_conversation_id },
      body: { accountId: channel.late_account_id, message: text },
    });

    const messageId = (res.data as any)?.data?.messageId ?? null;

    // Metadata update is best-effort — the message is already sent. A DB hiccup
    // here must NOT fall into the catch below and get recorded as a send failure
    // (that would pollute the very signal this observability exists to produce).
    try {
      await supabase
        .from("conversations")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: text.slice(0, 100),
        })
        .eq("id", conversationId)
        .eq("workspace_id", auth.workspaceId);
    } catch (metaErr) {
      console.error("post-send conversation metadata update failed:", metaErr);
    }

    await recordSendAttempt({
      workspaceId: auth.workspaceId, conversationId,
      lateConversationId: conversation.late_conversation_id,
      accountId: channel.late_account_id, platform, outcome: "success",
      httpStatus: 201, msSinceLastInbound, textLength,
    });

    // Return a message-shaped response for the UI's optimistic update
    return NextResponse.json(
      {
        id: messageId ?? `sent-${Date.now()}`,
        conversation_id: conversationId,
        direction: "outbound",
        text,
        attachments: null,
        quick_reply_payload: null,
        postback_payload: null,
        callback_data: null,
        platform_message_id: messageId,
        sent_by_flow_id: null,
        sent_by_node_id: null,
        sent_by_user_id: auth.userId,
        status: "sent",
        created_at: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    // Map the SDK error to a SAFE user message — invariant #1: never return SDK
    // text verbatim. The raw error is stored server-side + logged for debugging.
    const classified = classifySendError(error);
    const responseStatus =
      classified.zernioStatus && classified.zernioStatus >= 400 && classified.zernioStatus < 500
        ? classified.zernioStatus
        : 502;

    console.error(
      "Failed to send message via Zernio API:",
      `status=${classified.zernioStatus}`,
      classified.rawMessage
    );

    await recordSendAttempt({
      workspaceId: auth.workspaceId, conversationId,
      lateConversationId: conversation.late_conversation_id,
      accountId: channel.late_account_id, platform, outcome: classified.outcome,
      httpStatus: responseStatus, zernioStatus: classified.zernioStatus,
      errorMessage: classified.rawMessage, msSinceLastInbound, textLength,
    });

    return NextResponse.json(
      { error: classified.userMessage, windowExpired: classified.windowExpired },
      { status: responseStatus }
    );
  }
}

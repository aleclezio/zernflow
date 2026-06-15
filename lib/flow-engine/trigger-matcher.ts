import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, createGateway } from "ai";
import type { Database } from "@/lib/types/database";
import {
  messageKeywordMatches,
  messageHitsExcludeKeywords,
  type MessageKeywordConfig,
} from "@/lib/flow-engine/keyword-match";
import { getAiKey } from "@/lib/workspace-keys";
import {
  buildIntentList,
  parseIntentIndex,
  INTENT_CLASSIFIER_SYSTEM_PROMPT,
} from "@/lib/flow-engine/ai-intent";

// Cheap, fast model for one-token intent classification, addressed through the
// AI Gateway (same key custody as the AI-response node).
const INTENT_MODEL = "openai/gpt-4o-mini";

interface IncomingMessage {
  text?: string;
  postbackPayload?: string;
  quickReplyPayload?: string;
  sender?: { id: string };
}

type Trigger = Database["public"]["Tables"]["triggers"]["Row"];

export async function matchTrigger(
  supabase: SupabaseClient<Database>,
  channelId: string,
  conversationId: string,
  message: IncomingMessage
): Promise<Trigger | null> {
  // Get all active triggers for this channel (or global triggers with null channel_id)
  const { data: triggers } = await supabase
    .from("triggers")
    .select("*, flows!inner(status)")
    .or(`channel_id.eq.${channelId},channel_id.is.null`)
    .eq("is_active", true)
    .eq("flows.status", "published")
    .order("priority", { ascending: false });

  if (!triggers || triggers.length === 0) return null;

  // Priority order: postback > quick_reply > keyword > welcome > default
  // 1. Check postback triggers
  if (message.postbackPayload) {
    const match = triggers.find(
      (t) =>
        t.type === "postback" &&
        (t.config as { payload?: string })?.payload === message.postbackPayload
    );
    if (match) return match;
  }

  // 2. Check quick_reply triggers
  if (message.quickReplyPayload) {
    const match = triggers.find(
      (t) =>
        t.type === "quick_reply" &&
        (t.config as { payload?: string })?.payload ===
          message.quickReplyPayload
    );
    if (match) return match;
  }

  // 3. Check keyword triggers (with excludeKeywords disqualification)
  if (message.text) {
    for (const trigger of triggers.filter((t) => t.type === "keyword")) {
      if (messageKeywordMatches(trigger.config as MessageKeywordConfig, message.text)) {
        return trigger;
      }
    }
  }

  // 4. Check welcome trigger (first inbound message for this contact on this channel)
  // Count inbound messages in this specific conversation. If this is the only one
  // (count === 1), it means the current message is the contact's very first message.
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound");

  if (count === 1) {
    const welcomeTrigger = triggers.find((t) => t.type === "welcome");
    if (welcomeTrigger) return welcomeTrigger;
  }

  // 4.5. AI intent recognition (opt-in per workspace). If no keyword matched and
  // the workspace enabled it, ask the model to classify the message against the
  // keyword-trigger intents so semantically similar messages still route correctly
  // (e.g. "what's the cost?" → a "pricing" keyword). Best-effort: any failure falls
  // through to the default trigger below.
  const aiText = message.text?.trim();
  if (aiText) {
    const keywordTriggers = triggers
      .filter((t) => t.type === "keyword" && t.config)
      // Honor excludeKeywords across both layers: a trigger the user suppressed for
      // this message must not be re-offered to the classifier.
      .filter((t) => !messageHitsExcludeKeywords(t.config as MessageKeywordConfig, aiText))
      // Stable order so the model's numeric index maps to the same trigger every
      // time (the priority sort has no tiebreaker, so equal priorities are otherwise
      // non-deterministic).
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (keywordTriggers.length > 0) {
      const aiMatch = await matchByAiIntent(supabase, keywordTriggers, aiText, channelId);
      if (aiMatch) return aiMatch;
    }
  }

  // 5. Default trigger
  const defaultTrigger = triggers.find((t) => t.type === "default");
  return defaultTrigger || null;
}

/**
 * Use the AI Gateway to classify an incoming message against the keyword
 * triggers, returning the matched trigger or null. Best-effort and gated:
 *
 *  - opt-in only: the workspace must set `ai_intent_enabled` (a shared AI key
 *    configured for AI-response nodes must NOT silently start per-message
 *    intent billing);
 *  - key custody: the gateway key is read via `getAiKey` (decrypted, fail-closed),
 *    never a raw column select and never the platform env fallback — intent
 *    matching stays strictly per-workspace;
 *  - never blocks message processing: no key, a failed/timed-out (5s) call, or an
 *    invalid index all return null so the matcher falls through to the default.
 *
 * Never logs key material or the request URL.
 */
async function matchByAiIntent(
  supabase: SupabaseClient<Database>,
  keywordTriggers: Trigger[],
  messageText: string,
  channelId: string
): Promise<Trigger | null> {
  // Resolve the message's OWN workspace from its channel (no cross-tenant path).
  const { data: channel } = await supabase
    .from("channels")
    .select("workspace_id")
    .eq("id", channelId)
    .maybeSingle();
  if (!channel) return null;

  // Cheapest gate first: the opt-in toggle, before any key decrypt or network.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("ai_intent_enabled")
    .eq("id", channel.workspace_id)
    .maybeSingle();
  if (!workspace?.ai_intent_enabled) return null;

  const aiKey = await getAiKey(supabase, channel.workspace_id);
  if (!aiKey) return null;

  try {
    const gateway = createGateway({ apiKey: aiKey });
    const { text } = await generateText({
      model: gateway(INTENT_MODEL),
      system: INTENT_CLASSIFIER_SYSTEM_PROMPT,
      prompt: `Message: "${messageText}"\n\nIntents:\n${buildIntentList(keywordTriggers)}`,
      temperature: 0,
      maxOutputTokens: 10,
      abortSignal: AbortSignal.timeout(5000),
    });

    const index = parseIntentIndex(text, keywordTriggers.length);
    return index === null ? null : keywordTriggers[index];
  } catch (error) {
    // Best-effort — never block message processing. Log the message only, never the key/URL.
    console.error(
      "AI intent matching failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    return null;
  }
}

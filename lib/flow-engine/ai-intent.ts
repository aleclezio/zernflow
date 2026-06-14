/**
 * Pure helpers for AI intent recognition (see trigger-matcher.matchByAiIntent).
 * Kept network-free so the prompt-building and reply-parsing logic is unit-testable
 * without an LLM call. The matcher wires these to the AI Gateway.
 */
import type { Database } from "@/lib/types/database";

type Trigger = Database["public"]["Tables"]["triggers"]["Row"];

/** Stable system prompt for the intent classifier (no logic — exported for reuse/test). */
export const INTENT_CLASSIFIER_SYSTEM_PROMPT =
  "You are a message intent classifier. Given a user message and a numbered list of intents " +
  "(each with associated keywords), reply with ONLY the index number of the intent that best " +
  "matches the message. If no intent matches, reply with -1. Reply with ONLY the number.";

/**
 * Build a numbered intent list from keyword triggers, one line each, e.g.
 *   `0: keywords=[pricing, cost]`
 * Accepts upstream's two keyword shapes (plain string or `{ value }`) and tolerates
 * a null / keyword-less config.
 */
export function buildIntentList(keywordTriggers: Trigger[]): string {
  return keywordTriggers
    .map((trigger, i) => {
      const config = trigger.config as {
        keywords?: Array<string | { value: string }>;
      } | null;
      const keywords = (config?.keywords ?? []).map((k) =>
        typeof k === "string" ? k : k.value
      );
      return `${i}: keywords=[${keywords.join(", ")}]`;
    })
    .join("\n");
}

/**
 * Parse the model's reply into a valid trigger index, or null when it is not a
 * usable in-range index: non-numeric, the -1 "no match" sentinel, negative, or
 * out of range. Best-effort by design — any ambiguity falls through to null.
 */
export function parseIntentIndex(responseText: string, triggerCount: number): number | null {
  const index = Number.parseInt(responseText.trim(), 10);
  if (Number.isNaN(index) || index < 0 || index >= triggerCount) return null;
  return index;
}

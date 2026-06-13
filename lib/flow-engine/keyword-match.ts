/**
 * Pure keyword-trigger matching for inbound *messages* (DMs), mirroring the
 * comment matcher's semantics (lib/flow-engine/comment-matcher.ts) but for the
 * message keyword config shape (string | {value,matchType} keywords + a
 * config-level matchType fallback). Side-effect-free so it is unit-tested
 * without a DB.
 */
export type MatchType = "exact" | "contains" | "startsWith";

export interface MessageKeywordConfig {
  keywords?: Array<string | { value: string; matchType?: MatchType }>;
  /** If any of these appear in the message, the trigger is disqualified. */
  excludeKeywords?: string[];
  /** Fallback match type when a keyword entry doesn't specify its own. */
  matchType?: MatchType;
}

/** True if `text` matches the keyword config and is not disqualified by excludeKeywords. */
export function messageKeywordMatches(config: MessageKeywordConfig, text: string): boolean {
  const normalized = (text || "").toLowerCase().trim();
  if (!normalized || !config.keywords?.length) return false;

  let hit = false;
  for (const kw of config.keywords) {
    const keyword = (typeof kw === "string" ? kw : kw.value ?? "").toLowerCase().trim();
    if (!keyword) continue;
    const matchType = (typeof kw === "object" && kw.matchType) || config.matchType || "contains";
    if (matchType === "exact" && normalized === keyword) { hit = true; break; }
    if (matchType === "contains" && normalized.includes(keyword)) { hit = true; break; }
    if (matchType === "startsWith" && normalized.startsWith(keyword)) { hit = true; break; }
  }
  if (!hit) return false;

  const excluded = (config.excludeKeywords ?? []).some(
    (ek) => ek && normalized.includes(ek.toLowerCase())
  );
  return !excluded;
}

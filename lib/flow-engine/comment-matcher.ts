/**
 * Pure matcher for `comment_keyword` triggers against an incoming comment.
 *
 * Mirrors the message keyword semantics in trigger-matcher.ts but adds the
 * comment-only concerns: per-post scoping (config.postIds) and disqualifying
 * excludeKeywords. Kept side-effect-free so it is unit-tested without a DB.
 */
export interface CommentKeywordConfig {
  keywords: Array<{ value: string; matchType?: "exact" | "contains" | "startsWith" }>;
  /** When non-empty, only comments on these platform post ids match. */
  postIds?: string[];
  /** If any of these appear in the comment, the trigger is disqualified. */
  excludeKeywords?: string[];
}

export interface CommentTrigger {
  id: string;
  flow_id: string;
  channel_id: string | null;
  is_active: boolean;
  priority: number;
  config: CommentKeywordConfig;
}

export function matchCommentTrigger(
  text: string,
  platformPostId: string,
  triggers: CommentTrigger[]
): CommentTrigger | null {
  const normalized = (text || "").toLowerCase().trim();
  if (!normalized) return null;

  const candidates = triggers
    .filter((t) => t.is_active)
    .filter((t) => {
      const postIds = t.config?.postIds;
      // Empty/absent postIds = match on any post; otherwise scope to the list.
      return !postIds || postIds.length === 0 || postIds.includes(platformPostId);
    })
    .sort((a, b) => b.priority - a.priority);

  for (const t of candidates) {
    const cfg = t.config;
    if (!cfg?.keywords?.length) continue;

    const excluded = (cfg.excludeKeywords ?? []).some(
      (kw) => kw && normalized.includes(kw.toLowerCase())
    );
    if (excluded) continue;

    for (const kw of cfg.keywords) {
      const keyword = (kw.value ?? "").toLowerCase().trim();
      if (!keyword) continue;
      const matchType = kw.matchType ?? "contains";
      if (matchType === "exact" && normalized === keyword) return t;
      if (matchType === "contains" && normalized.includes(keyword)) return t;
      if (matchType === "startsWith" && normalized.startsWith(keyword)) return t;
    }
  }
  return null;
}

/**
 * Resolve the platform comment + post ids a private-reply needs, FAIL-CLOSED.
 *
 * A private reply must target the platform comment id (and its post). There is
 * NO safe fallback to the commenter's user id — using it mis-targets the DM.
 * Returns null (skip the reply) unless BOTH ids are present in the flow vars.
 */
export function resolvePrivateReplyIds(
  variables: Record<string, string> | undefined
): { commentId: string; postId: string } | null {
  const commentId = variables?.comment_id;
  const postId = variables?.post_id;
  if (!commentId || !postId) return null;
  return { commentId, postId };
}

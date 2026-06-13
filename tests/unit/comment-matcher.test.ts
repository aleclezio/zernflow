import { describe, it, expect } from "vitest";
import {
  matchCommentTrigger,
  resolvePrivateReplyIds,
  type CommentTrigger,
} from "@/lib/flow-engine/comment-matcher";

function trig(overrides: Partial<CommentTrigger> = {}): CommentTrigger {
  return {
    id: "t1",
    flow_id: "f1",
    channel_id: "c1",
    is_active: true,
    priority: 10,
    config: { keywords: [{ value: "info", matchType: "contains" }] },
    ...overrides,
  };
}

describe("matchCommentTrigger", () => {
  it("returns the trigger when a contains-keyword appears in the comment (case-insensitive)", () => {
    const t = trig();
    expect(matchCommentTrigger("Please send me INFO now", "P1", [t])).toBe(t);
  });

  it("does not match when no keyword is present", () => {
    expect(matchCommentTrigger("hello there", "P1", [trig()])).toBeNull();
  });

  it("exact match requires the whole comment to equal the keyword", () => {
    const t = trig({ config: { keywords: [{ value: "info", matchType: "exact" }] } });
    expect(matchCommentTrigger("info", "P1", [t])).toBe(t);
    expect(matchCommentTrigger("more info please", "P1", [t])).toBeNull();
  });

  it("startsWith match requires the comment to begin with the keyword", () => {
    const t = trig({ config: { keywords: [{ value: "info", matchType: "startsWith" }] } });
    expect(matchCommentTrigger("INFO please", "P1", [t])).toBe(t);
    expect(matchCommentTrigger("send info", "P1", [t])).toBeNull();
  });

  it("defaults to contains when matchType is omitted", () => {
    const t = trig({ config: { keywords: [{ value: "deal" }] } });
    expect(matchCommentTrigger("any DEAL here", "P1", [t])).toBe(t);
  });

  it("scopes to specific posts when postIds is set", () => {
    const t = trig({ config: { keywords: [{ value: "info" }], postIds: ["P1"] } });
    expect(matchCommentTrigger("info", "P1", [t])).toBe(t);
    expect(matchCommentTrigger("info", "P2", [t])).toBeNull();
  });

  it("matches any post when postIds is empty or absent", () => {
    expect(matchCommentTrigger("info", "ANY", [trig()])).not.toBeNull();
    const t = trig({ config: { keywords: [{ value: "info" }], postIds: [] } });
    expect(matchCommentTrigger("info", "ANY", [t])).toBe(t);
  });

  it("disqualifies when an excludeKeyword is present even if a keyword matches", () => {
    const t = trig({
      config: { keywords: [{ value: "info" }], excludeKeywords: ["spam"] },
    });
    expect(matchCommentTrigger("info please", "P1", [t])).toBe(t);
    expect(matchCommentTrigger("info but this is spam", "P1", [t])).toBeNull();
  });

  it("skips inactive triggers", () => {
    expect(matchCommentTrigger("info", "P1", [trig({ is_active: false })])).toBeNull();
  });

  it("returns the highest-priority trigger when several match", () => {
    const low = trig({ id: "low", priority: 1 });
    const high = trig({ id: "high", priority: 99 });
    expect(matchCommentTrigger("info", "P1", [low, high])).toBe(high);
  });

  it("handles empty comment text without matching", () => {
    expect(matchCommentTrigger("", "P1", [trig()])).toBeNull();
  });
});

describe("resolvePrivateReplyIds (fail-closed comment-target resolution)", () => {
  it("returns the platform comment + post ids when both are present", () => {
    expect(resolvePrivateReplyIds({ comment_id: "cmt-1", post_id: "post-1" })).toEqual({
      commentId: "cmt-1",
      postId: "post-1",
    });
  });

  it("fails closed (null) when comment_id is missing — never falls back to a user id", () => {
    expect(resolvePrivateReplyIds({ post_id: "post-1", commenter_name: "X" })).toBeNull();
  });

  it("fails closed (null) when post_id is missing", () => {
    expect(resolvePrivateReplyIds({ comment_id: "cmt-1" })).toBeNull();
  });

  it("fails closed (null) when variables are absent", () => {
    expect(resolvePrivateReplyIds(undefined)).toBeNull();
    expect(resolvePrivateReplyIds({})).toBeNull();
  });
});

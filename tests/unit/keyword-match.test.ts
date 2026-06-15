import { describe, it, expect } from "vitest";
import { messageKeywordMatches, messageHitsExcludeKeywords } from "@/lib/flow-engine/keyword-match";

describe("messageKeywordMatches", () => {
  it("matches by contains (default)", () => {
    expect(messageKeywordMatches({ keywords: ["price"] }, "what's the PRICE?")).toBe(true);
    expect(messageKeywordMatches({ keywords: ["price"] }, "hello there")).toBe(false);
  });

  it("honors per-keyword and config matchType", () => {
    expect(messageKeywordMatches({ keywords: [{ value: "hi", matchType: "exact" }] }, "hi")).toBe(true);
    expect(messageKeywordMatches({ keywords: [{ value: "hi", matchType: "exact" }] }, "hi there")).toBe(false);
    expect(messageKeywordMatches({ keywords: ["help"], matchType: "startsWith" }, "help me")).toBe(true);
    expect(messageKeywordMatches({ keywords: ["help"], matchType: "startsWith" }, "please help")).toBe(false);
  });

  it("disqualifies when an exclude keyword is present, even on a keyword hit", () => {
    expect(
      messageKeywordMatches({ keywords: ["price"], excludeKeywords: ["free"] }, "is the price free?")
    ).toBe(false);
    expect(
      messageKeywordMatches({ keywords: ["price"], excludeKeywords: ["free"] }, "what is the price?")
    ).toBe(true);
  });

  it("trims configured keyword values", () => {
    expect(messageKeywordMatches({ keywords: [{ value: "  price  " }] }, "the price")).toBe(true);
  });

  it("returns false for empty text or no keywords", () => {
    expect(messageKeywordMatches({ keywords: ["x"] }, "")).toBe(false);
    expect(messageKeywordMatches({ keywords: [] }, "anything")).toBe(false);
    expect(messageKeywordMatches({}, "anything")).toBe(false);
  });
});

describe("messageHitsExcludeKeywords", () => {
  it("is true when the message contains an exclude term (case-insensitive)", () => {
    expect(messageHitsExcludeKeywords({ keywords: ["price"], excludeKeywords: ["free"] }, "is it FREE?")).toBe(true);
  });

  it("is false when no exclude term is present", () => {
    expect(messageHitsExcludeKeywords({ keywords: ["price"], excludeKeywords: ["free"] }, "what is the price?")).toBe(false);
  });

  it("is false when there are no exclude keywords or the text is empty", () => {
    expect(messageHitsExcludeKeywords({ keywords: ["price"] }, "free stuff")).toBe(false);
    expect(messageHitsExcludeKeywords({ excludeKeywords: ["free"] }, "   ")).toBe(false);
  });
});

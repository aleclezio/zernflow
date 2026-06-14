import { describe, it, expect } from "vitest";
import { buildIntentList, parseIntentIndex } from "@/lib/flow-engine/ai-intent";
import type { Database } from "@/lib/types/database";

type Trigger = Database["public"]["Tables"]["triggers"]["Row"];

// Minimal trigger factory — buildIntentList only reads `config.keywords`.
const t = (keywords: unknown): Trigger => ({ config: { keywords } }) as unknown as Trigger;
const tRaw = (config: unknown): Trigger => ({ config }) as unknown as Trigger;

describe("buildIntentList", () => {
  it("numbers triggers from 0 and lists plain-string keywords", () => {
    expect(buildIntentList([t(["pricing", "cost"]), t(["support"])])).toBe(
      "0: keywords=[pricing, cost]\n1: keywords=[support]"
    );
  });

  it("unwraps { value } keyword objects and mixes both shapes", () => {
    expect(buildIntentList([t([{ value: "pricing" }, "cost"])])).toBe(
      "0: keywords=[pricing, cost]"
    );
  });

  it("renders an empty bracket for a trigger with no keywords", () => {
    expect(buildIntentList([t([]), t(["x"])])).toBe("0: keywords=[]\n1: keywords=[x]");
  });

  it("tolerates a null/keyword-less config without throwing", () => {
    expect(buildIntentList([tRaw(null), tRaw({})])).toBe("0: keywords=[]\n1: keywords=[]");
  });

  it("returns an empty string for no triggers", () => {
    expect(buildIntentList([])).toBe("");
  });
});

describe("parseIntentIndex", () => {
  it("returns the index for a valid in-range number", () => {
    expect(parseIntentIndex("0", 3)).toBe(0);
    expect(parseIntentIndex("2", 3)).toBe(2);
  });

  it("trims surrounding whitespace", () => {
    expect(parseIntentIndex("  1  ", 3)).toBe(1);
  });

  it("returns null for the no-match sentinel -1", () => {
    expect(parseIntentIndex("-1", 3)).toBeNull();
  });

  it("returns null for an out-of-range index", () => {
    expect(parseIntentIndex("3", 3)).toBeNull();
    expect(parseIntentIndex("1", 1)).toBeNull();
  });

  it("returns null for non-numeric or empty replies", () => {
    expect(parseIntentIndex("", 3)).toBeNull();
    expect(parseIntentIndex("none", 3)).toBeNull();
    expect(parseIntentIndex("foo 1", 3)).toBeNull();
  });
});

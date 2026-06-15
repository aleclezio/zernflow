import { describe, it, expect } from "vitest";
import { intersectSets, unionSets } from "@/lib/broadcast-segments";

const s = (...xs: string[]) => new Set(xs);
const sorted = (set: Set<string>) => [...set].sort();

describe("intersectSets (AND)", () => {
  it("returns an empty set for no input sets", () => {
    expect(intersectSets([]).size).toBe(0);
  });

  it("returns the single set's elements unchanged", () => {
    expect(sorted(intersectSets([s("a", "b")]))).toEqual(["a", "b"]);
  });

  it("keeps only elements present in every set", () => {
    expect(sorted(intersectSets([s("a", "b", "c"), s("b", "c", "d"), s("c", "b")]))).toEqual(["b", "c"]);
  });

  it("returns empty when the sets do not overlap", () => {
    expect(intersectSets([s("a"), s("b")]).size).toBe(0);
  });
});

describe("unionSets (OR)", () => {
  it("returns an empty set for no input sets", () => {
    expect(unionSets([]).size).toBe(0);
  });

  it("merges all elements and de-duplicates overlaps", () => {
    expect(sorted(unionSets([s("a", "b"), s("b", "c"), s("a")]))).toEqual(["a", "b", "c"]);
  });
});

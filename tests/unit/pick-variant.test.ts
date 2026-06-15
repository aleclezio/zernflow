import { describe, it, expect } from "vitest";
import { pickVariant } from "@/lib/flow-engine/pick-variant";

describe("pickVariant", () => {
  it("returns the base text when there are no variations", () => {
    expect(pickVariant("hello", undefined)).toBe("hello");
    expect(pickVariant("hello", [])).toBe("hello");
  });

  it("picks a variation deterministically given an rng", () => {
    const variations = ["a", "b", "c"];
    expect(pickVariant("base", variations, () => 0)).toBe("a");
    expect(pickVariant("base", variations, () => 0.5)).toBe("b");
    expect(pickVariant("base", variations, () => 0.99)).toBe("c");
  });

  it("ignores blank/non-string variations", () => {
    expect(pickVariant("base", ["  ", "real"], () => 0)).toBe("real");
    expect(pickVariant("base", ["   "], () => 0)).toBe("base");
  });
});

import { describe, it, expect } from "vitest";
import { AUTO_ASSIGN_MODES, isValidAutoAssignMode } from "@/lib/auto-assign";

describe("AUTO_ASSIGN_MODES / isValidAutoAssignMode", () => {
  it("is exactly manual + round-robin", () => {
    expect([...AUTO_ASSIGN_MODES].sort()).toEqual(["manual", "round-robin"]);
  });

  it("accepts the two valid modes", () => {
    expect(isValidAutoAssignMode("manual")).toBe(true);
    expect(isValidAutoAssignMode("round-robin")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidAutoAssignMode("auto")).toBe(false);
    expect(isValidAutoAssignMode("Round-Robin")).toBe(false);
    expect(isValidAutoAssignMode("")).toBe(false);
    expect(isValidAutoAssignMode("manual ")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { getSummary } from "@/components/flow-builder/nodes/action-node";

// Locks the UI<->engine field-name contract: the engine's executePrivateReply
// reads `data.text` (see lib/flow-engine/engine.ts). The builder must write and
// summarize that same field — a `message`/`text` mismatch would silently render
// "Not configured" and ship an unconfigured DM node.
describe("getSummary — privateReply", () => {
  it("previews the DM text when configured", () => {
    expect(
      getSummary({ actionType: "privateReply", text: "Thanks for commenting!" })
    ).toContain("Thanks for commenting!");
  });

  it("returns null when no text is set (node renders 'Not configured')", () => {
    expect(getSummary({ actionType: "privateReply" })).toBeNull();
  });
});

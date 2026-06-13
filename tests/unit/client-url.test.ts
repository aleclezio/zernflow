import { describe, it, expect, afterEach } from "vitest";
import { withBasePath } from "@/lib/client-url";

const ORIGINAL = process.env.NEXT_PUBLIC_BASE_PATH;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  } else {
    process.env.NEXT_PUBLIC_BASE_PATH = ORIGINAL;
  }
});

describe("withBasePath", () => {
  it("prefixes with NEXT_PUBLIC_BASE_PATH when set at build time", () => {
    // NEXT_PUBLIC_* is inlined at build; in tests it reads process.env directly
    process.env.NEXT_PUBLIC_BASE_PATH = "/engage";
    expect(withBasePath("/api/v1/channels/sync")).toBe("/engage/api/v1/channels/sync");
  });

  it("is a no-op when unset (local dev unchanged)", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(withBasePath("/api/v1/channels/sync")).toBe("/api/v1/channels/sync");
  });
});

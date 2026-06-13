import { describe, it, expect } from "vitest";
import { dmUrlForChannel } from "@/lib/ref-links";

describe("dmUrlForChannel", () => {
  it("maps each supported platform to its DM deep-link", () => {
    expect(dmUrlForChannel("instagram", "acme")).toBe("https://ig.me/m/acme");
    expect(dmUrlForChannel("facebook", "acme")).toBe("https://m.me/acme");
    expect(dmUrlForChannel("telegram", "acme")).toBe("https://t.me/acme");
    expect(dmUrlForChannel("twitter", "acme")).toBe(
      "https://twitter.com/messages/compose?recipient_id=acme"
    );
  });

  it("url-encodes the username (defence-in-depth)", () => {
    expect(dmUrlForChannel("instagram", "a b/c")).toBe("https://ig.me/m/a%20b%2Fc");
  });

  it("returns null when the username is missing", () => {
    expect(dmUrlForChannel("instagram", null)).toBeNull();
    expect(dmUrlForChannel("instagram", "")).toBeNull();
  });

  it("returns null for a platform with no DM deep-link", () => {
    expect(dmUrlForChannel("bluesky", "acme")).toBeNull();
    expect(dmUrlForChannel("reddit", "acme")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { isApiKeyExpired, generateApiKey, hashApiKey, keyPrefix } from "@/lib/api-key";

const NOW = Date.parse("2026-06-14T12:00:00.000Z");

describe("isApiKeyExpired", () => {
  it("treats a null expiry as never-expiring", () => {
    expect(isApiKeyExpired(null, NOW)).toBe(false);
  });

  it("is not expired for a future expiry", () => {
    expect(isApiKeyExpired("2026-06-14T12:00:01.000Z", NOW)).toBe(false);
  });

  it("is expired for a past expiry", () => {
    expect(isApiKeyExpired("2026-06-14T11:59:59.000Z", NOW)).toBe(true);
  });

  it("is expired at exactly the expiry instant (<=)", () => {
    expect(isApiKeyExpired("2026-06-14T12:00:00.000Z", NOW)).toBe(true);
  });

  it("fails closed (treats an unparseable expiry as expired)", () => {
    expect(isApiKeyExpired("not-a-date", NOW)).toBe(true);
  });
});

describe("generateApiKey", () => {
  it("produces a zf_-prefixed key with a 48-char hex body", () => {
    const k = generateApiKey();
    expect(k.startsWith("zf_")).toBe(true);
    expect(k.slice(3)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("is unique across calls", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("hashApiKey", () => {
  it("is the sha256 hex of the raw key (matches the verify path)", () => {
    const raw = "zf_deadbeef";
    expect(hashApiKey(raw)).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("is deterministic, 64 hex chars, and never the raw key", () => {
    const raw = generateApiKey();
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
    expect(hashApiKey(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(raw)).not.toBe(raw);
  });
});

describe("keyPrefix", () => {
  it("shows the first 12 chars plus an ellipsis (reveals no usable secret)", () => {
    const raw = "zf_0123456789abcdef";
    expect(keyPrefix(raw)).toBe("zf_012345678...");
    expect(keyPrefix(raw).length).toBeLessThan(raw.length);
  });
});

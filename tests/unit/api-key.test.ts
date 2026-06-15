import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  isApiKeyExpired,
  generateApiKey,
  hashApiKey,
  keyPrefix,
  isApiScope,
  parseScopes,
  hasScope,
} from "@/lib/api-key";

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

describe("isApiScope", () => {
  it("accepts the three known scopes", () => {
    expect(isApiScope("read")).toBe(true);
    expect(isApiScope("write")).toBe(true);
    expect(isApiScope("send")).toBe(true);
  });
  it("rejects unknown / non-string values", () => {
    expect(isApiScope("admin")).toBe(false);
    expect(isApiScope("")).toBe(false);
    expect(isApiScope(123)).toBe(false);
    expect(isApiScope(null)).toBe(false);
  });
});

describe("parseScopes", () => {
  it("accepts a valid subset and normalises to read,write,send order", () => {
    expect(parseScopes(["send", "read"])).toEqual(["read", "send"]);
    expect(parseScopes(["write"])).toEqual(["write"]);
  });
  it("dedupes", () => {
    expect(parseScopes(["read", "read", "write"])).toEqual(["read", "write"]);
  });
  it("returns null for an unknown scope, empty array, or non-array", () => {
    expect(parseScopes(["read", "admin"])).toBeNull();
    expect(parseScopes([])).toBeNull();
    expect(parseScopes("read")).toBeNull();
    expect(parseScopes(null)).toBeNull();
  });
});

describe("hasScope", () => {
  it("treats null/undefined scopes as full access (pre-scopes keys)", () => {
    expect(hasScope(null, "send")).toBe(true);
    expect(hasScope(undefined, "write")).toBe(true);
  });
  it("grants only the scopes the key holds", () => {
    expect(hasScope(["read"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
    expect(hasScope(["read"], "send")).toBe(false);
    expect(hasScope(["read", "write", "send"], "send")).toBe(true);
  });
});

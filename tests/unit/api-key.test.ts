import { describe, it, expect } from "vitest";
import { isApiKeyExpired } from "@/lib/api-key";

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

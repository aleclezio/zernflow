import { describe, it, expect, vi, afterEach } from "vitest";
import { checkRateLimit, _resetRateLimits } from "@/lib/rate-limit";

afterEach(() => {
  vi.useRealTimers();
  _resetRateLimits();
});

describe("checkRateLimit", () => {
  it("allows up to the limit within the window, then refuses", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("user-1", 5, 60_000)).toBe(true);
    }
    expect(checkRateLimit("user-1", 5, 60_000)).toBe(false);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 5; i++) checkRateLimit("user-1", 5, 60_000);
    expect(checkRateLimit("user-1", 5, 60_000)).toBe(false);
    expect(checkRateLimit("user-2", 5, 60_000)).toBe(true);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) checkRateLimit("user-1", 5, 60_000);
    expect(checkRateLimit("user-1", 5, 60_000)).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit("user-1", 5, 60_000)).toBe(true);
  });

  it("evicts stale entries so memory stays bounded", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 100; i++) checkRateLimit(`burst-${i}`, 5, 1_000);
    vi.advanceTimersByTime(120_000);
    checkRateLimit("fresh", 5, 1_000);
    expect(_entryCountForTests()).toBeLessThan(10);
  });
});

import { _entryCountForTests } from "@/lib/rate-limit";

import { describe, it, expect } from "vitest";
import { classifySendError } from "@/lib/send-attempts";

// A ZernioApiError-shaped object: the SDK throws an Error with a `statusCode`.
function zernioError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

describe("classifySendError", () => {
  it("classifies the Instagram messaging-window 403 as windowExpired with a safe, plain message", () => {
    const r = classifySendError(
      zernioError("This message is sent outside of allowed window.", 403)
    );
    expect(r.windowExpired).toBe(true);
    expect(r.zernioStatus).toBe(403);
    expect(r.outcome).toBe("zernio_error");
    // raw text preserved for server-side storage
    expect(r.rawMessage).toBe("This message is sent outside of allowed window.");
    // user message is safe + explains the 24h window, and is NOT the raw SDK text
    expect(r.userMessage).toMatch(/24 hour|window/i);
    expect(r.userMessage).not.toBe(r.rawMessage);
  });

  it("classifies a 429 as a rate-limit with a retry hint", () => {
    const r = classifySendError(zernioError("Too Many Requests", 429));
    expect(r.windowExpired).toBe(false);
    expect(r.zernioStatus).toBe(429);
    expect(r.userMessage).toMatch(/rate|try again|moment/i);
  });

  it("classifies a 401 as an auth/permission failure pointing at reconnecting", () => {
    const r = classifySendError(zernioError("Unauthorized", 401));
    expect(r.zernioStatus).toBe(401);
    expect(r.userMessage).toMatch(/auth|permission|reconnect|api key/i);
  });

  it("falls back to a generic safe message for an unknown Zernio error and never leaks the raw text", () => {
    const r = classifySendError(zernioError("weird internal detail xyz", 400));
    expect(r.zernioStatus).toBe(400);
    expect(r.outcome).toBe("zernio_error");
    expect(r.rawMessage).toBe("weird internal detail xyz");
    expect(r.userMessage).not.toMatch(/weird internal detail xyz/);
    expect(r.userMessage.length).toBeGreaterThan(0);
  });

  it("classifies a non-Zernio throw (no statusCode) as an exception with null status", () => {
    const r = classifySendError(new Error("fetch failed"));
    expect(r.outcome).toBe("exception");
    expect(r.zernioStatus).toBeNull();
    expect(r.rawMessage).toBe("fetch failed");
    expect(r.userMessage).not.toMatch(/fetch failed/);
  });

  it("handles a non-Error throw without crashing", () => {
    const r = classifySendError("string failure");
    expect(r.outcome).toBe("exception");
    expect(r.zernioStatus).toBeNull();
    expect(typeof r.userMessage).toBe("string");
  });
});

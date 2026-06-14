import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  WEBHOOK_EVENTS,
  isValidWebhookEvent,
  buildWebhookPayload,
  signWebhookPayload,
  isDeliverySuccess,
  nextFailureState,
  generateWebhookSecret,
} from "@/lib/webhook-events";

describe("WEBHOOK_EVENTS / isValidWebhookEvent", () => {
  it("advertises exactly the 7 wired events", () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      [
        "contact.created",
        "flow.completed",
        "flow.started",
        "message.received",
        "message.sent",
        "tag.added",
        "tag.removed",
      ].sort()
    );
  });

  it("accepts every wired event", () => {
    for (const e of WEBHOOK_EVENTS) expect(isValidWebhookEvent(e)).toBe(true);
  });

  it("rejects upstream events that have no dispatch site here", () => {
    expect(isValidWebhookEvent("contact.updated")).toBe(false);
    expect(isValidWebhookEvent("conversation.opened")).toBe(false);
    expect(isValidWebhookEvent("conversation.closed")).toBe(false);
  });

  it("rejects garbage and empty strings", () => {
    expect(isValidWebhookEvent("garbage")).toBe(false);
    expect(isValidWebhookEvent("")).toBe(false);
  });
});

describe("buildWebhookPayload", () => {
  it("wraps event/timestamp/data in the delivery envelope", () => {
    const ts = "2026-06-14T12:00:00.000Z";
    const data = { contactId: "c1", text: "hi" };
    expect(buildWebhookPayload("message.received", data, ts)).toEqual({
      event: "message.received",
      timestamp: ts,
      data,
    });
  });
});

describe("signWebhookPayload", () => {
  it("is the HMAC-SHA256 hex of the body under the secret (what receivers recompute)", () => {
    const body = JSON.stringify({ event: "flow.started", a: 1 });
    const secret = "whsec_test";
    expect(signWebhookPayload(body, secret)).toBe(
      createHmac("sha256", secret).update(body).digest("hex")
    );
  });

  it("is deterministic, 64 hex chars, and changes with the secret", () => {
    const body = "abc";
    expect(signWebhookPayload(body, "s1")).toMatch(/^[0-9a-f]{64}$/);
    expect(signWebhookPayload(body, "s1")).toBe(signWebhookPayload(body, "s1"));
    expect(signWebhookPayload(body, "s1")).not.toBe(signWebhookPayload(body, "s2"));
  });
});

describe("isDeliverySuccess", () => {
  it("is true only for 2xx", () => {
    for (const s of [200, 201, 202, 204, 299]) expect(isDeliverySuccess(s)).toBe(true);
    for (const s of [0, 100, 199, 300, 301, 400, 404, 500]) expect(isDeliverySuccess(s)).toBe(false);
  });
});

describe("nextFailureState", () => {
  it("increments the failure count", () => {
    expect(nextFailureState(0)).toEqual({ failureCount: 1, disabled: false });
    expect(nextFailureState(8)).toEqual({ failureCount: 9, disabled: false });
  });

  it("auto-disables at the 10th consecutive failure", () => {
    expect(nextFailureState(9)).toEqual({ failureCount: 10, disabled: true });
  });

  it("stays disabled past 10", () => {
    expect(nextFailureState(10)).toEqual({ failureCount: 11, disabled: true });
  });
});

describe("generateWebhookSecret", () => {
  it("produces a whsec_-prefixed key with a 48-char hex body", () => {
    const s = generateWebhookSecret();
    expect(s.startsWith("whsec_")).toBe(true);
    expect(s.slice(6)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("is unique across calls", () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

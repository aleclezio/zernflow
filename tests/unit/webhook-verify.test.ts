import { describe, it, expect } from "vitest";
import { createHmac, createHash, randomBytes } from "node:crypto";
import {
  verifySignature,
  pickSignatureHeader,
  resolveEventId,
} from "@/lib/webhook-verify";

const secret = randomBytes(24).toString("base64url");
const body = JSON.stringify({ event: "message.received", id: "evt-1" });
const goodSig = createHmac("sha256", secret).update(body).digest("hex");

describe("verifySignature", () => {
  it("accepts the correct HMAC-SHA256 hex signature", () => {
    expect(verifySignature(body, goodSig, secret)).toBe(true);
  });

  it("rejects a wrong signature of the same length", () => {
    const wrong = createHmac("sha256", "other-secret").update(body).digest("hex");
    expect(verifySignature(body, wrong, secret)).toBe(false);
  });

  it("rejects a signature over a different body", () => {
    expect(verifySignature(body + "x", goodSig, secret)).toBe(false);
  });

  it("rejects length-mismatched signatures WITHOUT throwing (no 500 oracle)", () => {
    expect(verifySignature(body, "deadbeef", secret)).toBe(false);
    expect(verifySignature(body, goodSig + "00", secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
  });

  it("is case-tolerant on the hex signature", () => {
    expect(verifySignature(body, goodSig.toUpperCase(), secret)).toBe(true);
  });
});

describe("pickSignatureHeader", () => {
  const h = (entries: Record<string, string>) => new Headers(entries);

  it("uses the canonical x-zernio-signature", () => {
    expect(pickSignatureHeader(h({ "x-zernio-signature": "abc" }))).toBe("abc");
  });

  it("canonical wins when both are present", () => {
    expect(
      pickSignatureHeader(h({ "x-zernio-signature": "canon", "x-late-signature": "legacy" }))
    ).toBe("canon");
  });

  it("falls back to legacy x-late-signature only when canonical is absent", () => {
    expect(pickSignatureHeader(h({ "x-late-signature": "legacy" }))).toBe("legacy");
  });

  it("treats an empty canonical header as absent", () => {
    expect(
      pickSignatureHeader(h({ "x-zernio-signature": "", "x-late-signature": "legacy" }))
    ).toBe("legacy");
    expect(pickSignatureHeader(h({ "x-zernio-signature": "" }))).toBeNull();
  });

  it("returns null when neither is present", () => {
    expect(pickSignatureHeader(h({}))).toBeNull();
  });
});

describe("resolveEventId", () => {
  const h = (entries: Record<string, string>) => new Headers(entries);

  it("prefers the X-Zernio-Event-Id header", () => {
    const r = resolveEventId(h({ "x-zernio-event-id": "evt-h" }), { id: "evt-p" }, body);
    expect(r).toEqual({ eventId: "evt-h", synthetic: false });
  });

  it("falls back to payload.id", () => {
    const r = resolveEventId(h({}), { id: "evt-p" }, body);
    expect(r).toEqual({ eventId: "evt-p", synthetic: false });
  });

  it("synthesizes a stable sha256(raw body) id when no id exists", () => {
    const expected = createHash("sha256").update(body).digest("hex");
    const r = resolveEventId(h({}), {}, body);
    expect(r).toEqual({ eventId: expected, synthetic: true });
  });

  it("rejects oversized ids (>128 chars) by falling back to the synthetic id", () => {
    const huge = "e".repeat(200);
    const expected = createHash("sha256").update(body).digest("hex");
    const r = resolveEventId(h({}), { id: huge }, body);
    expect(r).toEqual({ eventId: expected, synthetic: true });
  });
});

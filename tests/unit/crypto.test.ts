import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, isEncrypted, SecretCryptoError } from "@/lib/crypto";

// Keys are generated at runtime — never literal key material in source.
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY_A;
});

describe("encryptSecret / decryptSecret", () => {
  it("roundtrips a secret bound to a workspace id", () => {
    const ct = encryptSecret("my-zernio-api-key", WS_A);
    expect(decryptSecret(ct, WS_A)).toBe("my-zernio-api-key");
  });

  it("produces enc:v1 format with base64url segments", () => {
    const ct = encryptSecret("s3cret", WS_A);
    const parts = ct.split(":");
    expect(parts[0]).toBe("enc");
    expect(parts[1]).toBe("v1");
    expect(parts).toHaveLength(5);
    for (const seg of parts.slice(2)) {
      expect(seg).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding chars
    }
  });

  it("uses a fresh IV per encryption (same input twice differs)", () => {
    expect(encryptSecret("same", WS_A)).not.toBe(encryptSecret("same", WS_A));
  });

  it("rejects tampered ciphertext", () => {
    const ct = encryptSecret("secret", WS_A);
    const parts = ct.split(":");
    const body = parts[4];
    const flipped = body[0] === "A" ? "B" : "A";
    parts[4] = flipped + body.slice(1);
    expect(() => decryptSecret(parts.join(":"), WS_A)).toThrow(SecretCryptoError);
  });

  it("rejects decryption under a different workspace id (AAD binding)", () => {
    const ct = encryptSecret("secret", WS_A);
    expect(() => decryptSecret(ct, WS_B)).toThrow(SecretCryptoError);
  });

  it("rejects decryption with a different key", () => {
    const ct = encryptSecret("secret", WS_A);
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptSecret(ct, WS_A)).toThrow(SecretCryptoError);
  });

  it("rejects values without the enc:v1 prefix (legacy plaintext fails closed)", () => {
    expect(() => decryptSecret("raw-pasted-api-key", WS_A)).toThrow(SecretCryptoError);
    expect(() => decryptSecret("enc:v2:a:b:c", WS_A)).toThrow(SecretCryptoError);
    expect(() => decryptSecret("enc:v1:only:three", WS_A)).toThrow(SecretCryptoError);
  });

  it("throws a clear error when APP_ENCRYPTION_KEY is missing", () => {
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => encryptSecret("x", WS_A)).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => decryptSecret("enc:v1:a:b:c", WS_A)).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it("throws when APP_ENCRYPTION_KEY is not 32 bytes", () => {
    process.env.APP_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => encryptSecret("x", WS_A)).toThrow(/32/);
  });
});

describe("isEncrypted", () => {
  it("detects enc:v1 values", () => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
    expect(isEncrypted(encryptSecret("x", WS_A))).toBe(true);
    expect(isEncrypted("raw-key")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

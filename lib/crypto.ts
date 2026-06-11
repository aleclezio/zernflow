/**
 * Application-layer encryption for per-workspace secrets (Zernio API keys,
 * AI gateway keys, webhook secrets).
 *
 * Format: enc:v1:<b64url iv>:<b64url tag>:<b64url ciphertext>
 *
 * - AES-256-GCM, random 12-byte IV per encryption
 * - AAD = workspace id, so ciphertext cannot be copied between workspace rows
 * - Key from APP_ENCRYPTION_KEY (base64, exactly 32 bytes) — env only, never the DB
 *
 * Values without the enc:v1 prefix are never treated as secrets: decryptSecret
 * throws, callers fail closed and ask the user to re-enter the key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc";
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

function loadKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new SecretCryptoError(
      "APP_ENCRYPTION_KEY is not set — required to encrypt/decrypt workspace secrets"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `APP_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes`
    );
  }
  return key;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}:${VERSION}:`);
}

export function encryptSecret(plaintext: string, aad: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(":");
}

export function decryptSecret(value: string, aad: string): string {
  const key = loadKey();
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== VERSION) {
    throw new SecretCryptoError("value is not in enc:v1 format");
  }
  const [, , ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Never propagate OpenSSL internals — no oracle beyond pass/fail.
    throw new SecretCryptoError("decryption failed (wrong key, tampered value, or wrong workspace)");
  }
}

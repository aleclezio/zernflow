import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret } from "@/lib/crypto";
import {
  getZernioKey,
  getAiKey,
  workspaceKeyStatus,
} from "@/lib/workspace-keys";

process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const WS = "33333333-3333-4333-8333-333333333333";

/** Minimal stub of the supabase query chain used by the accessor. */
function stubClient(row: { late_api_key_encrypted?: string | null; ai_api_key?: string | null } | null) {
  return {
    from(table: string) {
      expect(table).toBe("workspaces");
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  // key set at module top; individual tests don't mutate it
});

describe("getZernioKey", () => {
  it("decrypts an enc:v1 value bound to the workspace", async () => {
    const stored = encryptSecret("zern-key-123", WS);
    const key = await getZernioKey(stubClient({ late_api_key_encrypted: stored }), WS);
    expect(key).toBe("zern-key-123");
  });

  it("returns null when no key is stored", async () => {
    expect(await getZernioKey(stubClient({ late_api_key_encrypted: null }), WS)).toBeNull();
    expect(await getZernioKey(stubClient(null), WS)).toBeNull();
  });

  it("fails closed on legacy plaintext values (never returns them)", async () => {
    const key = await getZernioKey(stubClient({ late_api_key_encrypted: "raw-legacy-key" }), WS);
    expect(key).toBeNull();
  });

  it("fails closed when ciphertext belongs to another workspace", async () => {
    const stolen = encryptSecret("zern-key-123", "44444444-4444-4444-8444-444444444444");
    const key = await getZernioKey(stubClient({ late_api_key_encrypted: stolen }), WS);
    expect(key).toBeNull();
  });
});

describe("getAiKey", () => {
  it("decrypts and fails closed the same way", async () => {
    const stored = encryptSecret("ai-key-456", WS);
    expect(await getAiKey(stubClient({ ai_api_key: stored }), WS)).toBe("ai-key-456");
    expect(await getAiKey(stubClient({ ai_api_key: "legacy" }), WS)).toBeNull();
    expect(await getAiKey(stubClient({ ai_api_key: null }), WS)).toBeNull();
  });
});

describe("workspaceKeyStatus", () => {
  it("reports configured only for enc:v1 values", () => {
    const enc = encryptSecret("k", WS);
    expect(workspaceKeyStatus({ late_api_key_encrypted: enc, ai_api_key: null })).toEqual({
      hasApiKey: true,
      hasAiKey: false,
    });
    // Legacy plaintext = NOT configured -> the UI prompts re-entry.
    expect(workspaceKeyStatus({ late_api_key_encrypted: "legacy", ai_api_key: "legacy" })).toEqual({
      hasApiKey: false,
      hasAiKey: false,
    });
  });
});

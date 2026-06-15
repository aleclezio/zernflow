import { describe, it, expect, vi } from "vitest";
import { anonClient, serviceClient, createTestUser } from "./helpers";

// updateWorkspaceSettings reads the session client via @/lib/supabase/server.
// Point it at the authed test-user client so getUser() + the membership check pass.
const state = vi.hoisted(() => ({ authed: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.authed ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

import { updateWorkspaceSettings } from "@/lib/actions/workspace";

async function readToggle(workspaceId: string): Promise<boolean> {
  const { data } = await serviceClient()
    .from("workspaces")
    .select("ai_intent_enabled")
    .eq("id", workspaceId)
    .single();
  return data!.ai_intent_enabled;
}

describe("updateWorkspaceSettings — ai_intent_enabled", () => {
  it("persists the toggle ON and back OFF (explicit-undefined guard lets false through)", async () => {
    const owner = await createTestUser("ws-toggle");
    state.authed = owner.client;

    const on = await updateWorkspaceSettings(owner.workspaceId, { aiIntentEnabled: true });
    expect(on).toMatchObject({ ok: true });
    expect(await readToggle(owner.workspaceId)).toBe(true);

    // The regression-prone path: false is falsy, so a truthy check would silently drop it.
    const off = await updateWorkspaceSettings(owner.workspaceId, { aiIntentEnabled: false });
    expect(off).toMatchObject({ ok: true });
    expect(await readToggle(owner.workspaceId)).toBe(false);
  });
});

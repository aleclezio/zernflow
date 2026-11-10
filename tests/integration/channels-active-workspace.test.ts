import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { anonClient, serviceClient, createTestUser } from "./helpers";
import { encryptSecret } from "@/lib/crypto";

// The channels page resolves the SELECTED workspace (active_profile_id cookie,
// lib/workspace.ts). The channels API routes must resolve the SAME workspace —
// before this fix they used the caller's first membership (.limit(1).single()),
// so "Sync" on one client's Channels page synced a different workspace and the
// page then showed that other workspace's channels until reload.

let currentClient: SupabaseClient<Database> | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));

let cookieJar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name in cookieJar ? { value: cookieJar[name] } : undefined),
  }),
}));

const listAccounts = vi.fn();
const getConnectUrl = vi.fn();
vi.mock("@/lib/zernio-client", () => ({
  createZernioClient: () => ({
    accounts: { listAccounts },
    connect: { getConnectUrl },
  }),
}));

import { GET as channelsGET } from "@/app/api/v1/channels/route";
import { POST as syncPOST } from "@/app/api/v1/channels/sync/route";
import { POST as connectPOST } from "@/app/api/v1/channels/connect/route";

beforeEach(() => {
  currentClient = null;
  cookieJar = {};
  listAccounts.mockReset();
  getConnectUrl.mockReset();
});

// One operator, two client workspaces, each bound to its own Zernio profile.
// The first membership is the operator's own workspace (A); the cookie selects B.
async function operatorWithTwoClients(label: string) {
  const owner = await createTestUser(label);
  const svc = serviceClient();
  const pA = `prof-A-${crypto.randomUUID()}`;
  const pB = `prof-B-${crypto.randomUUID()}`;
  await svc.from("workspaces").update({ zernio_profile_id: pA }).eq("id", owner.workspaceId);
  const { data: wsB } = await svc
    .from("workspaces")
    .insert({ name: "Client B", slug: `wsb-${crypto.randomUUID().slice(0, 8)}`, zernio_profile_id: pB })
    .select("id")
    .single();
  await svc.from("workspace_members").insert({ workspace_id: wsB!.id, user_id: owner.userId, role: "owner" });
  currentClient = owner.client;
  cookieJar["active_profile_id"] = pB; // the operator is looking at client B
  return { owner, wsA: owner.workspaceId, wsB: wsB!.id, pA, pB };
}

describe("channels API routes use the SELECTED workspace, not the first membership", () => {
  it("GET /channels lists the selected workspace's channels", async () => {
    const { wsA, wsB } = await operatorWithTwoClients("ch-get");
    const svc = serviceClient();
    await svc.from("channels").insert({ workspace_id: wsA, platform: "instagram", late_account_id: `acc-A-${crypto.randomUUID()}`, is_active: true });
    await svc.from("channels").insert({ workspace_id: wsB, platform: "facebook", late_account_id: `acc-B-${crypto.randomUUID()}`, is_active: true });

    const res = await channelsGET();
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ workspace_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].workspace_id).toBe(wsB);
  });

  it("POST /channels/sync syncs the selected workspace and its bound profile", async () => {
    const { wsA, wsB, pB } = await operatorWithTwoClients("ch-sync");
    await serviceClient()
      .from("workspaces")
      .update({ late_api_key_encrypted: encryptSecret("test-key-value", wsB) })
      .eq("id", wsB);
    const accB = `acc-B-${crypto.randomUUID()}`;
    listAccounts.mockResolvedValue({
      data: { accounts: [{ _id: accB, platform: "instagram", username: "client-b", profileId: pB }] },
    });

    const res = await syncPOST();
    expect(res.status).toBe(200);
    expect(listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ profileId: pB }) })
    );

    const body = (await res.json()) as { channels: Array<{ workspace_id: string; late_account_id: string }> };
    expect(body.channels.map((c) => c.workspace_id)).toEqual([wsB]);

    const { data: inA } = await serviceClient().from("channels").select("id").eq("workspace_id", wsA);
    const { data: inB } = await serviceClient().from("channels").select("late_account_id").eq("workspace_id", wsB);
    expect(inA ?? []).toEqual([]);
    expect((inB ?? []).map((c) => c.late_account_id)).toEqual([accB]);
  });

  it("POST /channels/connect uses the selected workspace's bound profile", async () => {
    const { wsB, pB } = await operatorWithTwoClients("ch-connect");
    await serviceClient()
      .from("workspaces")
      .update({ late_api_key_encrypted: encryptSecret("test-key-value", wsB) })
      .eq("id", wsB);
    getConnectUrl.mockResolvedValue({ data: { authUrl: "https://example.test/oauth" } });

    const res = await connectPOST(
      new NextRequest("http://localhost:3000/api/v1/channels/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "instagram" }),
      })
    );
    expect(res.status).toBe(200);
    expect(getConnectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ profileId: pB }) })
    );
  });
});

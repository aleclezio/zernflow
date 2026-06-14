import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { serviceClient, anonClient, createTestUser } from "./helpers";

const session = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => session.client ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { updateWorkspaceSettings } from "@/lib/actions/workspace";

let A: string; // workspace A
let ownerAClient: unknown;
let memberOrder: string[]; // A's members in the rotation's stable order

async function setMode(workspaceId: string, mode: string, idx = 0) {
  await serviceClient()
    .from("workspaces")
    .update({ auto_assign_mode: mode, last_assigned_member_index: idx })
    .eq("id", workspaceId);
}

async function assign(workspaceId: string, conversationId: string): Promise<string | null> {
  const { data } = await serviceClient().rpc("assign_next_member", {
    p_workspace_id: workspaceId,
    p_conversation_id: conversationId,
  });
  return data;
}

async function counter(workspaceId: string): Promise<number> {
  const { data } = await serviceClient()
    .from("workspaces")
    .select("last_assigned_member_index")
    .eq("id", workspaceId)
    .single();
  return data!.last_assigned_member_index;
}

beforeAll(async () => {
  const a = await createTestUser("rr-A");
  A = a.workspaceId;
  ownerAClient = a.client;
  const u2 = await createTestUser("rr-2");
  const u3 = await createTestUser("rr-3");
  await serviceClient()
    .from("workspace_members")
    .insert([
      { workspace_id: A, user_id: u2.userId, role: "member" },
      { workspace_id: A, user_id: u3.userId, role: "member" },
    ]);
  const { data: members } = await serviceClient()
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", A)
    .order("created_at", { ascending: true })
    .order("user_id", { ascending: true });
  memberOrder = (members ?? []).map((m) => m.user_id);
});

beforeEach(async () => {
  session.client = null;
  await setMode(A, "round-robin", 0);
});

describe("assign_next_member RPC", () => {
  it("rotates through every member in stable order and wraps", async () => {
    expect(memberOrder.length).toBe(3);
    const dummy = randomUUID();
    const seq: (string | null)[] = [];
    for (let i = 0; i < 4; i++) seq.push(await assign(A, dummy));
    expect(seq).toEqual([memberOrder[0], memberOrder[1], memberOrder[2], memberOrder[0]]);
  });

  it("advances the per-workspace counter", async () => {
    await assign(A, randomUUID());
    expect(await counter(A)).toBe(1);
  });

  it("no-ops in manual mode (returns null, counter unchanged)", async () => {
    await setMode(A, "manual", 0);
    expect(await assign(A, randomUUID())).toBeNull();
    expect(await counter(A)).toBe(0);
  });

  it("assigns conversations.assigned_to on a real conversation", async () => {
    const { data: ch } = await serviceClient()
      .from("channels")
      .insert({ workspace_id: A, platform: "instagram", late_account_id: `acc-${randomUUID()}`, is_active: true })
      .select("id")
      .single();
    const { data: ct } = await serviceClient()
      .from("contacts")
      .insert({ workspace_id: A, display_name: "RR contact" })
      .select("id")
      .single();
    const { data: conv } = await serviceClient()
      .from("conversations")
      .insert({ workspace_id: A, channel_id: ch!.id, contact_id: ct!.id, platform: "instagram" })
      .select("id")
      .single();

    const assignee = await assign(A, conv!.id);
    expect(assignee).toBe(memberOrder[0]);

    const { data: updated } = await serviceClient()
      .from("conversations")
      .select("assigned_to")
      .eq("id", conv!.id)
      .single();
    expect(updated!.assigned_to).toBe(assignee);
  });

  it("only ever returns the workspace's own members (tenant scope)", async () => {
    const dummy = randomUUID();
    for (let i = 0; i < 5; i++) {
      const uid = await assign(A, dummy);
      expect(memberOrder).toContain(uid);
    }
  });
});

describe("updateWorkspaceSettings — auto-assign mode", () => {
  beforeEach(() => {
    session.client = ownerAClient;
  });

  it("persists a valid mode", async () => {
    const r = await updateWorkspaceSettings(A, { autoAssignMode: "round-robin" });
    expect(r).toEqual({ ok: true });
    const { data: w } = await serviceClient()
      .from("workspaces")
      .select("auto_assign_mode")
      .eq("id", A)
      .single();
    expect(w!.auto_assign_mode).toBe("round-robin");
  });

  it("rejects an invalid mode without writing", async () => {
    await setMode(A, "manual", 0);
    const r = await updateWorkspaceSettings(A, { autoAssignMode: "nonsense" });
    expect(r.error).toBeTruthy();
    const { data: w } = await serviceClient()
      .from("workspaces")
      .select("auto_assign_mode")
      .eq("id", A)
      .single();
    expect(w!.auto_assign_mode).toBe("manual");
  });
});

import { describe, it, expect } from "vitest";
import { serviceClient, anonClient, createTestUser } from "./helpers";

/**
 * Tenant-isolation lockdown (verified upstream holes):
 * - scheduled_jobs RLS was open to ANY authenticated user ("system-level"
 *   per 00009) -> any signup could inject resume_flow / send_broadcast jobs
 *   that the cron processor executes with the service role.
 * - increment_* RPCs were SECURITY DEFINER with no scoping and EXECUTE for
 *   anon/authenticated -> cross-tenant writes for anyone.
 * - workspaces UPDATE was member-level -> any member could overwrite the
 *   workspace API keys or rebind the Zernio profile.
 * - channels was FOR ALL member-level -> arbitrary late_account_id planting.
 */

describe("scheduled_jobs is service-role only", () => {
  it("denies INSERT to authenticated users", async () => {
    const user = await createTestUser("tl-jobs-insert");
    const { error } = await user.client.from("scheduled_jobs").insert({
      type: "send_broadcast",
      payload: { broadcastId: "x", recipientId: "y" },
      run_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });

  it("denies SELECT to authenticated users", async () => {
    const user = await createTestUser("tl-jobs-select");
    const { data, error } = await user.client.from("scheduled_jobs").select("id").limit(1);
    // RLS: either an error or an empty set, never rows
    expect(error !== null || (data ?? []).length === 0).toBe(true);

    // and the service role CAN see the table (sanity that RLS, not the table, is the gate)
    const { error: svcErr } = await serviceClient().from("scheduled_jobs").select("id").limit(1);
    expect(svcErr).toBeNull();
  });
});

describe("increment_* RPCs are not callable by anon/authenticated", () => {
  it("denies increment_unread to anon and authenticated users", async () => {
    const victim = await createTestUser("tl-rpc-victim");

    // seed a conversation in the victim workspace
    const accountId = `acc-${crypto.randomUUID()}`;
    const { data: channel } = await serviceClient()
      .from("channels")
      .insert({
        workspace_id: victim.workspaceId,
        platform: "instagram",
        late_account_id: accountId,
        is_active: true,
      })
      .select("id")
      .single();
    const { data: contact } = await serviceClient()
      .from("contacts")
      .insert({ workspace_id: victim.workspaceId, display_name: "V" })
      .select("id")
      .single();
    const { data: conv } = await serviceClient()
      .from("conversations")
      .insert({
        workspace_id: victim.workspaceId,
        channel_id: channel!.id,
        contact_id: contact!.id,
        platform: "instagram",
        unread_count: 0,
      })
      .select("id")
      .single();

    const attacker = await createTestUser("tl-rpc-attacker");
    const { error: authErr } = await attacker.client.rpc("increment_unread", {
      conv_id: conv!.id,
      preview: "poisoned preview",
    });
    expect(authErr).not.toBeNull();

    const { error: anonErr } = await anonClient().rpc("increment_unread", {
      conv_id: conv!.id,
      preview: "poisoned preview",
    });
    expect(anonErr).not.toBeNull();

    // victim's conversation untouched
    const { data: after } = await serviceClient()
      .from("conversations")
      .select("unread_count, last_message_preview")
      .eq("id", conv!.id)
      .single();
    expect(after?.unread_count).toBe(0);
    expect(after?.last_message_preview).toBeNull();
  });

  it("denies increment_broadcast_sent/failed to authenticated users", async () => {
    const victim = await createTestUser("tl-rpc-bcast");
    const { data: broadcast } = await serviceClient()
      .from("broadcasts")
      .insert({
        workspace_id: victim.workspaceId,
        name: "B",
        status: "sending",
        message_content: { text: "hi" },
      })
      .select("id")
      .single();

    const attacker = await createTestUser("tl-rpc-bcast-attacker");
    const { error: sentErr } = await attacker.client.rpc("increment_broadcast_sent", {
      b_id: broadcast!.id,
    });
    expect(sentErr).not.toBeNull();
    const { error: failedErr } = await attacker.client.rpc("increment_broadcast_failed", {
      b_id: broadcast!.id,
    });
    expect(failedErr).not.toBeNull();

    const { data: after } = await serviceClient()
      .from("broadcasts")
      .select("sent, failed")
      .eq("id", broadcast!.id)
      .single();
    expect(after?.sent).toBe(0);
    expect(after?.failed).toBe(0);
  });
});

describe("workspace credential columns are owner-gated", () => {
  it("denies a non-owner member overwriting the API key column", async () => {
    const owner = await createTestUser("tl-cred-owner");
    const member = await createTestUser("tl-cred-member");
    await owner.client.from("workspace_members").insert({
      workspace_id: owner.workspaceId,
      user_id: member.userId,
      role: "member",
    });

    const { error } = await member.client
      .from("workspaces")
      .update({ late_api_key_encrypted: "enc:v1:attacker:swapped:value" })
      .eq("id", owner.workspaceId)
      .select("id")
      .single();
    expect(error).not.toBeNull();

    const { data: after } = await serviceClient()
      .from("workspaces")
      .select("late_api_key_encrypted")
      .eq("id", owner.workspaceId)
      .single();
    expect(after?.late_api_key_encrypted).toBeNull();
  });

  it("denies a non-owner member rebinding the Zernio profile", async () => {
    const owner = await createTestUser("tl-bind-owner");
    const member = await createTestUser("tl-bind-member");
    await owner.client.from("workspace_members").insert({
      workspace_id: owner.workspaceId,
      user_id: member.userId,
      role: "member",
    });

    const { error } = await member.client
      .from("workspaces")
      .update({ zernio_profile_id: `prof-${crypto.randomUUID()}` })
      .eq("id", owner.workspaceId)
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  it("still allows members to update non-credential fields (name)", async () => {
    const owner = await createTestUser("tl-name-owner");
    const member = await createTestUser("tl-name-member");
    await owner.client.from("workspace_members").insert({
      workspace_id: owner.workspaceId,
      user_id: member.userId,
      role: "member",
    });

    const { error } = await member.client
      .from("workspaces")
      .update({ name: "Renamed by member" })
      .eq("id", owner.workspaceId)
      .select("id")
      .single();
    expect(error).toBeNull();
  });

  it("still allows the owner to update credentials through the app paths", async () => {
    const owner = await createTestUser("tl-owner-self");
    const { error } = await owner.client
      .from("workspaces")
      .update({ zernio_profile_id: `prof-${crypto.randomUUID()}` })
      .eq("id", owner.workspaceId)
      .select("id")
      .single();
    expect(error).toBeNull();
  });
});

describe("channels cannot be planted from the browser", () => {
  it("denies direct INSERT by workspace members (sync is server-side only)", async () => {
    const user = await createTestUser("tl-chan-insert");
    const { error } = await user.client.from("channels").insert({
      workspace_id: user.workspaceId,
      platform: "instagram",
      late_account_id: `acc-planted-${crypto.randomUUID()}`,
      is_active: true,
    });
    expect(error).not.toBeNull();
  });

  it("still allows members to toggle is_active (channels UI)", async () => {
    const user = await createTestUser("tl-chan-toggle");
    const { data: channel } = await serviceClient()
      .from("channels")
      .insert({
        workspace_id: user.workspaceId,
        platform: "instagram",
        late_account_id: `acc-${crypto.randomUUID()}`,
        is_active: true,
      })
      .select("id")
      .single();

    const { error } = await user.client
      .from("channels")
      .update({ is_active: false })
      .eq("id", channel!.id)
      .select("id")
      .single();
    expect(error).toBeNull();
  });
});

describe("flow engine workspace scoping", () => {
  it("does not execute a flow belonging to another workspace", async () => {
    const wsA = await createTestUser("tl-eng-a");
    const wsB = await createTestUser("tl-eng-b");

    // flow + channel + contact + conversation all in B
    const svc = serviceClient();
    const { data: flowB } = await svc
      .from("flows")
      .insert({
        workspace_id: wsB.workspaceId,
        name: "B flow",
        status: "published",
        nodes: [
          { id: "t", type: "trigger", data: { triggerType: "keyword" }, position: { x: 0, y: 0 } },
          { id: "s", type: "addTag", data: { action: "add", tagName: "fired" }, position: { x: 1, y: 0 } },
        ],
        edges: [{ id: "e", source: "t", target: "s" }],
      })
      .select("id")
      .single();
    const { data: channelA } = await svc
      .from("channels")
      .insert({
        workspace_id: wsA.workspaceId,
        platform: "instagram",
        late_account_id: `acc-${crypto.randomUUID()}`,
        is_active: true,
      })
      .select("id")
      .single();
    const { data: contactA } = await svc
      .from("contacts")
      .insert({ workspace_id: wsA.workspaceId, display_name: "A contact" })
      .select("id")
      .single();
    const { data: convA } = await svc
      .from("conversations")
      .insert({
        workspace_id: wsA.workspaceId,
        channel_id: channelA!.id,
        contact_id: contactA!.id,
        platform: "instagram",
      })
      .select("id")
      .single();

    const { executeFlow } = await import("@/lib/flow-engine/engine");
    // context claims workspace A but points at B's flow
    await executeFlow(svc, {
      triggerId: "",
      flowId: flowB!.id,
      channelId: channelA!.id,
      contactId: contactA!.id,
      conversationId: convA!.id,
      workspaceId: wsA.workspaceId,
      incomingMessage: {},
    });

    const { data: sessions } = await svc
      .from("flow_sessions")
      .select("id")
      .eq("flow_id", flowB!.id);
    expect(sessions).toEqual([]);
  });

  // Written AFTER the budget implementation by design: against the old code
  // this scenario recurses forever (goToFlow reset depth to 0), which would
  // hang the suite rather than fail it.
  it("terminates a goToFlow self-cycle via the global node budget", async () => {
    const ws = await createTestUser("tl-cycle");
    const svc = serviceClient();

    const { data: flow } = await svc
      .from("flows")
      .insert({
        workspace_id: ws.workspaceId,
        name: "cycle",
        status: "published",
        nodes: [],
        edges: [],
      })
      .select("id")
      .single();

    await svc
      .from("flows")
      .update({
        nodes: [
          { id: "t", type: "trigger", data: { triggerType: "keyword" }, position: { x: 0, y: 0 } },
          { id: "g", type: "goToFlow", data: { flowId: flow!.id, returnAfter: false }, position: { x: 1, y: 0 } },
        ],
        edges: [{ id: "e", source: "t", target: "g" }],
      })
      .eq("id", flow!.id);

    const { data: channel } = await svc
      .from("channels")
      .insert({
        workspace_id: ws.workspaceId,
        platform: "instagram",
        late_account_id: `acc-${crypto.randomUUID()}`,
        is_active: true,
      })
      .select("id")
      .single();
    const { data: contact } = await svc
      .from("contacts")
      .insert({ workspace_id: ws.workspaceId, display_name: "C" })
      .select("id")
      .single();
    const { data: conv } = await svc
      .from("conversations")
      .insert({
        workspace_id: ws.workspaceId,
        channel_id: channel!.id,
        contact_id: contact!.id,
        platform: "instagram",
      })
      .select("id")
      .single();

    const { executeFlow } = await import("@/lib/flow-engine/engine");
    // Terminating at all (within the test timeout) is the assertion.
    await executeFlow(svc, {
      triggerId: "",
      flowId: flow!.id,
      channelId: channel!.id,
      contactId: contact!.id,
      conversationId: conv!.id,
      workspaceId: ws.workspaceId,
      incomingMessage: {},
    });

    const { count } = await svc
      .from("analytics_events")
      .select("id", { count: "exact", head: true })
      .eq("flow_id", flow!.id)
      .eq("event_type", "node_executed");
    expect(count).toBeLessThanOrEqual(201);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { serviceClient, createTestUser } from "./helpers";
import { setAiKey } from "@/lib/workspace-keys";
import type { Database } from "@/lib/types/database";

type TriggerInsert = Database["public"]["Tables"]["triggers"]["Insert"];

// Mock the AI Gateway so no real model call is made. generateTextMock is the seam
// each test controls; createGateway returns a callable model factory.
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", () => ({
  createGateway: () => (model: string) => ({ model }),
  generateText: generateTextMock,
}));

import { matchTrigger } from "@/lib/flow-engine/trigger-matcher";

const message = { text: "how much will this run me" }; // matches no keyword

/**
 * Build a published flow with two keyword triggers (pricing=index 0 via higher
 * priority, support=index 1), a default trigger to fall through to, and a
 * conversation with one inbound non-matching message (no welcome trigger → the
 * AI-intent step is reached).
 */
async function rig(label: string) {
  const owner = await createTestUser(`ai-${label}`);
  const svc = serviceClient();

  const { data: channel } = await svc
    .from("channels")
    .insert({
      workspace_id: owner.workspaceId,
      platform: "instagram",
      late_account_id: `acc-${crypto.randomUUID()}`,
      is_active: true,
    })
    .select("id")
    .single();

  const { data: flow } = await svc
    .from("flows")
    .insert({ workspace_id: owner.workspaceId, name: "ai-intent flow", status: "published" })
    .select("id")
    .single();

  const mkTrigger = (type: TriggerInsert["type"], config: TriggerInsert["config"], priority: number) =>
    svc
      .from("triggers")
      .insert({
        flow_id: flow!.id,
        channel_id: channel!.id,
        type,
        config,
        is_active: true,
        priority,
      })
      .select("id")
      .single();

  // Distinct priorities make the keyword-trigger order (and thus the AI index)
  // deterministic: pricing=0, support=1.
  const { data: pricing } = await mkTrigger("keyword", { keywords: ["pricing"] }, 20);
  const { data: support } = await mkTrigger("keyword", { keywords: ["support"] }, 10);
  const { data: def } = await mkTrigger("default", {}, 0);

  const { data: contact } = await svc
    .from("contacts")
    .insert({ workspace_id: owner.workspaceId, display_name: "Visitor" })
    .select("id")
    .single();

  const { data: conv } = await svc
    .from("conversations")
    .insert({
      workspace_id: owner.workspaceId,
      channel_id: channel!.id,
      contact_id: contact!.id,
      platform: "instagram",
    })
    .select("id")
    .single();

  await svc
    .from("messages")
    .insert({ conversation_id: conv!.id, direction: "inbound", text: message.text });

  return {
    workspaceId: owner.workspaceId,
    channelId: channel!.id,
    conversationId: conv!.id,
    triggers: { pricing: pricing!.id, support: support!.id, default: def!.id },
  };
}

const enableIntent = (workspaceId: string) =>
  serviceClient().from("workspaces").update({ ai_intent_enabled: true }).eq("id", workspaceId);

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("matchTrigger — AI intent recognition", () => {
  it("does NOT call the model when the toggle is off, even with a key configured", async () => {
    const r = await rig("toggle-off");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key"); // key set, toggle stays default-false

    const trigger = await matchTrigger(serviceClient(), r.channelId, r.conversationId, message);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(trigger?.id).toBe(r.triggers.default);
  });

  it("does NOT call the model when enabled but no AI key is configured", async () => {
    const r = await rig("no-key");
    await enableIntent(r.workspaceId); // toggle on, but no key

    const trigger = await matchTrigger(serviceClient(), r.channelId, r.conversationId, message);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(trigger?.id).toBe(r.triggers.default);
  });

  it("routes to the AI-selected keyword trigger when enabled with a key", async () => {
    const r = await rig("match");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    generateTextMock.mockResolvedValue({ text: "0" }); // → pricing (index 0)

    const trigger = await matchTrigger(serviceClient(), r.channelId, r.conversationId, message);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(trigger?.id).toBe(r.triggers.pricing);
  });

  it("falls through to default when the model returns the no-match sentinel", async () => {
    const r = await rig("no-match");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    generateTextMock.mockResolvedValue({ text: "-1" });

    const trigger = await matchTrigger(serviceClient(), r.channelId, r.conversationId, message);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(trigger?.id).toBe(r.triggers.default);
  });

  it("falls through to default when the model call throws (best-effort)", async () => {
    const r = await rig("throws");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    generateTextMock.mockRejectedValue(new Error("gateway down"));

    const trigger = await matchTrigger(serviceClient(), r.channelId, r.conversationId, message);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(trigger?.id).toBe(r.triggers.default);
  });
});

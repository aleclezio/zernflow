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

interface KeywordSpec {
  keywords: Array<string | { value: string }>;
  excludeKeywords?: string[];
}

/**
 * Build a published flow with the given keyword triggers (all equal priority, so
 * the AI index→trigger mapping must rely on the matcher's stable id-sort, not on
 * priority), a default trigger to fall through to, and a conversation with one
 * inbound message (no welcome trigger → the AI-intent step is reached).
 */
async function rig(
  label: string,
  opts: { keywords?: KeywordSpec[]; text?: string } = {}
) {
  const keywords = opts.keywords ?? [{ keywords: ["pricing"] }, { keywords: ["support"] }];
  const text = opts.text ?? "how much will this run me"; // matches no keyword

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

  const mkTrigger = (type: TriggerInsert["type"], config: TriggerInsert["config"]) =>
    svc
      .from("triggers")
      .insert({ flow_id: flow!.id, channel_id: channel!.id, type, config, is_active: true, priority: 10 })
      .select("id")
      .single();

  const keywordIds: string[] = [];
  for (const spec of keywords) {
    const { data } = await mkTrigger("keyword", {
      keywords: spec.keywords,
      ...(spec.excludeKeywords ? { excludeKeywords: spec.excludeKeywords } : {}),
    });
    keywordIds.push(data!.id);
  }
  const { data: def } = await mkTrigger("default", {});

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

  await svc.from("messages").insert({ conversation_id: conv!.id, direction: "inbound", text });

  return {
    workspaceId: owner.workspaceId,
    channelId: channel!.id,
    conversationId: conv!.id,
    keywordIds, // in insertion order
    defaultId: def!.id,
    text,
  };
}

const enableIntent = (workspaceId: string) =>
  serviceClient().from("workspaces").update({ ai_intent_enabled: true }).eq("id", workspaceId);

const run = (r: { channelId: string; conversationId: string; text: string }, text?: string) =>
  matchTrigger(serviceClient(), r.channelId, r.conversationId, { text: text ?? r.text });

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("matchTrigger — AI intent recognition", () => {
  it("does NOT call the model when the toggle is off, even with a key configured", async () => {
    const r = await rig("toggle-off");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key"); // key set, toggle stays default-false

    const trigger = await run(r);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(trigger?.id).toBe(r.defaultId);
  });

  it("does NOT call the model when enabled but no AI key is configured", async () => {
    const r = await rig("no-key");
    await enableIntent(r.workspaceId); // toggle on, but no key

    const trigger = await run(r);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(trigger?.id).toBe(r.defaultId);
  });

  it("maps the model index to the keyword trigger in stable id-sorted order", async () => {
    const r = await rig("match");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    const sorted = [...r.keywordIds].sort(); // matcher sorts candidates by id
    generateTextMock.mockResolvedValue({ text: "0" });

    const t0 = await run(r);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(t0?.id).toBe(sorted[0]);
  });

  it("maps index 1 to the second id-sorted trigger", async () => {
    const r = await rig("match-1");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    const sorted = [...r.keywordIds].sort();
    generateTextMock.mockResolvedValue({ text: "1" });

    const t1 = await run(r);

    expect(t1?.id).toBe(sorted[1]);
  });

  it("falls through to default when the model returns the no-match sentinel", async () => {
    const r = await rig("no-match");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    generateTextMock.mockResolvedValue({ text: "-1" });

    const trigger = await run(r);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(trigger?.id).toBe(r.defaultId);
  });

  it("falls through to default when the model call throws (best-effort)", async () => {
    const r = await rig("throws");
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    generateTextMock.mockRejectedValue(new Error("gateway down"));

    const trigger = await run(r);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(trigger?.id).toBe(r.defaultId);
  });

  it("excludes an excludeKeywords-disqualified trigger from the AI candidate set", async () => {
    // "pricing" excludes "free"; the message hits the exclude and matches no keyword,
    // so only "support" is a candidate → index 0 must be support, never pricing.
    const r = await rig("exclude", {
      keywords: [{ keywords: ["pricing"], excludeKeywords: ["free"] }, { keywords: ["support"] }],
      text: "is this thing free",
    });
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);
    generateTextMock.mockResolvedValue({ text: "0" });

    const trigger = await run(r);

    expect(trigger?.id).toBe(r.keywordIds[1]); // support
    expect(trigger?.id).not.toBe(r.keywordIds[0]); // pricing was filtered out
  });

  it("does NOT call the model for a whitespace-only message", async () => {
    const r = await rig("whitespace", { text: "   " });
    await setAiKey(serviceClient(), r.workspaceId, "gw-test-key");
    await enableIntent(r.workspaceId);

    const trigger = await run(r, "   ");

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(trigger?.id).toBe(r.defaultId);
  });
});

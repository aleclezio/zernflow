import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { anonClient, serviceClient, createTestUser } from "./helpers";

let currentClient: SupabaseClient<Database> | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { GET as listReplies, POST as createReply } from "@/app/api/v1/saved-replies/route";
import { PUT as updateReply, DELETE as deleteReply } from "@/app/api/v1/saved-replies/[replyId]/route";
import { GET as listNotes, POST as createNote } from "@/app/api/v1/conversations/[conversationId]/notes/route";
import { DELETE as deleteNote } from "@/app/api/v1/conversations/[conversationId]/notes/[noteId]/route";
import { GET as listRefLinks, POST as createRefLink } from "@/app/api/v1/ref-links/route";
import { PUT as updateRefLink, DELETE as deleteRefLink } from "@/app/api/v1/ref-links/[refLinkId]/route";
import { GET as refLinkQr } from "@/app/api/v1/ref-links/[refLinkId]/qr/route";
import RefLinkPage from "@/app/r/[slug]/page";

const URL = "http://localhost:3000/api/v1/saved-replies";
const get = () => new NextRequest(URL);
const postJson = (body: unknown) =>
  new NextRequest(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const putJson = (body: unknown) =>
  new NextRequest(URL, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  currentClient = null;
});

describe("saved replies", () => {
  it("creates and lists a workspace's replies", async () => {
    const a = await createTestUser("sr-create");
    currentClient = a.client;

    const created = await createReply(postJson({ title: "Greeting", content: "Hi there!", shortcut: "hi" }));
    expect(created.status).toBe(201);
    const reply = await created.json();
    expect(reply.workspace_id).toBe(a.workspaceId);

    const listed = await (await listReplies(get())).json();
    expect(listed.data.some((r: { id: string }) => r.id === reply.id)).toBe(true);
  });

  it("requires title and content (400)", async () => {
    const a = await createTestUser("sr-validate");
    currentClient = a.client;
    expect((await createReply(postJson({ title: "x" }))).status).toBe(400);
  });

  it("cannot update or delete another workspace's reply", async () => {
    const a = await createTestUser("sr-a");
    const b = await createTestUser("sr-b");
    currentClient = a.client;
    const reply = await (await createReply(postJson({ title: "T", content: "C" }))).json();

    // B tries to mutate A's reply
    currentClient = b.client;
    const upd = await updateReply(putJson({ title: "hacked" }), { params: Promise.resolve({ replyId: reply.id }) });
    expect(upd.status).toBe(404);
    await deleteReply(get(), { params: Promise.resolve({ replyId: reply.id }) });

    // A's reply is untouched
    const { data: still } = await serviceClient().from("saved_replies").select("title").eq("id", reply.id).single();
    expect(still?.title).toBe("T");
  });

  it("owner can update and delete their reply", async () => {
    const a = await createTestUser("sr-owner");
    currentClient = a.client;
    const reply = await (await createReply(postJson({ title: "T", content: "C" }))).json();

    const upd = await updateReply(putJson({ content: "C2" }), { params: Promise.resolve({ replyId: reply.id }) });
    expect(upd.status).toBe(200);
    expect((await upd.json()).content).toBe("C2");

    const del = await deleteReply(get(), { params: Promise.resolve({ replyId: reply.id }) });
    expect(del.status).toBe(200);
    const { data: gone } = await serviceClient().from("saved_replies").select("id").eq("id", reply.id).maybeSingle();
    expect(gone).toBeNull();
  });
});

/** Seed a conversation (channel + contact + conversation) for a workspace. */
async function seedConversation(workspaceId: string) {
  const svc = serviceClient();
  const { data: channel } = await svc
    .from("channels")
    .insert({ workspace_id: workspaceId, platform: "instagram", late_account_id: `acct-${crypto.randomUUID()}` })
    .select("id")
    .single();
  const { data: contact } = await svc
    .from("contacts")
    .insert({ workspace_id: workspaceId, display_name: "Jane" })
    .select("id")
    .single();
  const { data: convo } = await svc
    .from("conversations")
    .insert({ workspace_id: workspaceId, channel_id: channel!.id, contact_id: contact!.id, platform: "instagram" })
    .select("id")
    .single();
  return convo!.id;
}

const notesParams = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });

describe("conversation notes", () => {
  it("adds and lists a note on a workspace's conversation", async () => {
    const a = await createTestUser("notes-create");
    const convoId = await seedConversation(a.workspaceId);
    currentClient = a.client;

    const created = await createNote(postJson({ content: "Called the lead" }), notesParams(convoId));
    expect(created.status).toBe(201);
    const note = await created.json();
    expect(note.workspace_id).toBe(a.workspaceId);
    expect(note.user_id).toBe(a.userId);
    expect(note.content).toBe("Called the lead");

    const listed = await (await listNotes(get(), notesParams(convoId))).json();
    expect(listed.data.some((n: { id: string }) => n.id === note.id)).toBe(true);
  });

  it("requires non-empty content (400)", async () => {
    const a = await createTestUser("notes-validate");
    const convoId = await seedConversation(a.workspaceId);
    currentClient = a.client;
    expect((await createNote(postJson({ content: "   " }), notesParams(convoId))).status).toBe(400);
  });

  it("cannot read or add notes on another workspace's conversation (404)", async () => {
    const a = await createTestUser("notes-a");
    const b = await createTestUser("notes-b");
    const convoId = await seedConversation(a.workspaceId);

    currentClient = b.client;
    expect((await listNotes(get(), notesParams(convoId))).status).toBe(404);
    expect((await createNote(postJson({ content: "x" }), notesParams(convoId))).status).toBe(404);
  });

  it("deletes own note; a cross-workspace delete leaves it intact", async () => {
    const a = await createTestUser("notes-del-a");
    const b = await createTestUser("notes-del-b");
    const convoId = await seedConversation(a.workspaceId);

    currentClient = a.client;
    const note = await (await createNote(postJson({ content: "secret" }), notesParams(convoId))).json();

    // B's workspace-scoped delete must not remove A's note
    currentClient = b.client;
    await deleteNote(get(), { params: Promise.resolve({ conversationId: convoId, noteId: note.id }) });
    const { data: still } = await serviceClient().from("conversation_notes").select("id").eq("id", note.id).maybeSingle();
    expect(still).not.toBeNull();

    // A deletes their own
    currentClient = a.client;
    const del = await deleteNote(get(), { params: Promise.resolve({ conversationId: convoId, noteId: note.id }) });
    expect(del.status).toBe(200);
    const { data: gone } = await serviceClient().from("conversation_notes").select("id").eq("id", note.id).maybeSingle();
    expect(gone).toBeNull();
  });
});

async function seedFlow(workspaceId: string) {
  const { data } = await serviceClient()
    .from("flows")
    .insert({ workspace_id: workspaceId, name: "Flow", nodes: [], edges: [] })
    .select("id")
    .single();
  return data!.id;
}

async function seedChannel(workspaceId: string, username: string | null = null) {
  const { data } = await serviceClient()
    .from("channels")
    .insert({ workspace_id: workspaceId, platform: "instagram", late_account_id: `acct-${crypto.randomUUID()}`, username })
    .select("id")
    .single();
  return data!.id;
}

const refParams = (refLinkId: string) => ({ params: Promise.resolve({ refLinkId }) });

describe("ref links", () => {
  it("creates and lists a ref link for the workspace", async () => {
    const a = await createTestUser("rl-create");
    const flowId = await seedFlow(a.workspaceId);
    currentClient = a.client;

    const created = await createRefLink(postJson({ name: "Spring promo", flowId }));
    expect(created.status).toBe(201);
    const link = await created.json();
    expect(link.workspace_id).toBe(a.workspaceId);
    expect(link.slug).toMatch(/^[0-9a-f]{8}$/);
    expect(link.flows.name).toBe("Flow");

    const listed = await (await listRefLinks(get())).json();
    expect(listed.data.some((l: { id: string }) => l.id === link.id)).toBe(true);
  });

  it("requires name and flowId (400)", async () => {
    const a = await createTestUser("rl-validate");
    currentClient = a.client;
    expect((await createRefLink(postJson({ name: "x" }))).status).toBe(400);
  });

  it("rejects a flowId from another workspace (404)", async () => {
    const a = await createTestUser("rl-flow-a");
    const b = await createTestUser("rl-flow-b");
    const foreignFlow = await seedFlow(b.workspaceId);
    currentClient = a.client;
    const res = await createRefLink(postJson({ name: "x", flowId: foreignFlow }));
    expect(res.status).toBe(404);
  });

  it("rejects a channelId from another workspace (404)", async () => {
    const a = await createTestUser("rl-chan-a");
    const b = await createTestUser("rl-chan-b");
    const flowId = await seedFlow(a.workspaceId);
    const foreignChannel = await seedChannel(b.workspaceId, "acme");
    currentClient = a.client;
    const res = await createRefLink(postJson({ name: "x", flowId, channelId: foreignChannel }));
    expect(res.status).toBe(404);
  });

  it("cannot update or delete another workspace's ref link (404), and it stays intact", async () => {
    const a = await createTestUser("rl-x-a");
    const b = await createTestUser("rl-x-b");
    const flowId = await seedFlow(a.workspaceId);
    currentClient = a.client;
    const link = await (await createRefLink(postJson({ name: "Mine", flowId }))).json();

    currentClient = b.client;
    expect((await updateRefLink(putJson({ name: "hacked" }), refParams(link.id))).status).toBe(404);
    await deleteRefLink(get(), refParams(link.id));

    const { data: still } = await serviceClient().from("ref_links").select("name").eq("id", link.id).single();
    expect(still?.name).toBe("Mine");
  });

  it("owner can toggle is_active and delete", async () => {
    const a = await createTestUser("rl-owner");
    const flowId = await seedFlow(a.workspaceId);
    currentClient = a.client;
    const link = await (await createRefLink(postJson({ name: "Mine", flowId }))).json();

    const upd = await updateRefLink(putJson({ is_active: false }), refParams(link.id));
    expect(upd.status).toBe(200);
    expect((await upd.json()).data.is_active).toBe(false);

    const del = await deleteRefLink(get(), refParams(link.id));
    expect(del.status).toBe(200);
    const { data: gone } = await serviceClient().from("ref_links").select("id").eq("id", link.id).maybeSingle();
    expect(gone).toBeNull();
  });

  it("QR returns publicUrl + SVG for own link, 404 across workspaces", async () => {
    const a = await createTestUser("rl-qr-a");
    const b = await createTestUser("rl-qr-b");
    const flowId = await seedFlow(a.workspaceId);
    currentClient = a.client;
    const link = await (await createRefLink(postJson({ name: "QR", flowId }))).json();

    const qr = await refLinkQr(get(), refParams(link.id));
    expect(qr.status).toBe(200);
    const body = await qr.json();
    expect(body.publicUrl).toContain(`/r/${link.slug}`);
    expect(body.qrSvg).toContain("<svg");

    currentClient = b.client;
    expect((await refLinkQr(get(), refParams(link.id))).status).toBe(404);
  });

  it("public redirect counts a click for an active link and skips an inactive one", async () => {
    const a = await createTestUser("rl-public");
    const flowId = await seedFlow(a.workspaceId);
    const channelId = await seedChannel(a.workspaceId, "acme");
    const svc = serviceClient();

    const activeSlug = `act${crypto.randomUUID().slice(0, 8)}`;
    await svc.from("ref_links").insert({
      workspace_id: a.workspaceId, flow_id: flowId, channel_id: channelId, name: "A", slug: activeSlug, is_active: true,
    });
    // Active link redirects (throws NEXT_REDIRECT) — capture it and assert both
    // the redirect and the click side-effect (so the active branch can't pass vacuously).
    let redirectDigest: string | undefined;
    await RefLinkPage({ params: Promise.resolve({ slug: activeSlug }) }).catch((e) => {
      redirectDigest = (e as { digest?: string })?.digest;
    });
    expect(redirectDigest).toContain("NEXT_REDIRECT");
    const { data: active } = await svc.from("ref_links").select("clicks").eq("slug", activeSlug).single();
    expect(active!.clicks).toBe(1);

    const inactiveSlug = `ina${crypto.randomUUID().slice(0, 8)}`;
    await svc.from("ref_links").insert({
      workspace_id: a.workspaceId, flow_id: flowId, channel_id: channelId, name: "I", slug: inactiveSlug, is_active: false,
    });
    await RefLinkPage({ params: Promise.resolve({ slug: inactiveSlug }) }).catch(() => undefined);
    const { data: inactive } = await svc.from("ref_links").select("clicks").eq("slug", inactiveSlug).single();
    expect(inactive!.clicks).toBe(0);
  });
});

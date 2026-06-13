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

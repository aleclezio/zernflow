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

import { GET as listFields, POST as createField } from "@/app/api/v1/bot-fields/route";
import { PUT as updateField, DELETE as deleteField } from "@/app/api/v1/bot-fields/[fieldId]/route";

const URL = "http://localhost:3000/api/v1/bot-fields";
const get = () => new NextRequest(URL);
const postJson = (body: unknown) =>
  new NextRequest(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const putJson = (body: unknown) =>
  new NextRequest(URL, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fieldParams = (fieldId: string) => ({ params: Promise.resolve({ fieldId }) });

beforeEach(() => {
  currentClient = null;
});

describe("bot fields", () => {
  it("creates and lists a bot field", async () => {
    const a = await createTestUser("bf-create");
    currentClient = a.client;

    const created = await createField(postJson({ name: "Business name", slug: "business_name", value: "Acme" }));
    expect(created.status).toBe(201);
    const field = await created.json();
    expect(field.workspace_id).toBe(a.workspaceId);
    expect(field.slug).toBe("business_name");

    const listed = await (await listFields(get())).json();
    expect(listed.data.some((f: { id: string }) => f.id === field.id)).toBe(true);
  });

  it("requires name and slug (400)", async () => {
    const a = await createTestUser("bf-validate");
    currentClient = a.client;
    expect((await createField(postJson({ name: "x" }))).status).toBe(400);
  });

  it("rejects an invalid slug (400)", async () => {
    const a = await createTestUser("bf-slug");
    currentClient = a.client;
    expect((await createField(postJson({ name: "x", slug: "Bad Slug" }))).status).toBe(400);
    expect((await createField(postJson({ name: "x", slug: "1leading_digit" }))).status).toBe(400);
  });

  it("rejects a duplicate slug within the workspace (409)", async () => {
    const a = await createTestUser("bf-dup");
    currentClient = a.client;
    expect((await createField(postJson({ name: "A", slug: "dup" }))).status).toBe(201);
    expect((await createField(postJson({ name: "B", slug: "dup" }))).status).toBe(409);
  });

  it("cannot update or delete another workspace's field (404), and it stays intact", async () => {
    const a = await createTestUser("bf-x-a");
    const b = await createTestUser("bf-x-b");
    currentClient = a.client;
    const field = await (await createField(postJson({ name: "Mine", slug: "mine" }))).json();

    currentClient = b.client;
    expect((await updateField(putJson({ value: "hacked" }), fieldParams(field.id))).status).toBe(404);
    await deleteField(get(), fieldParams(field.id));

    const { data: still } = await serviceClient().from("bot_fields").select("name").eq("id", field.id).single();
    expect(still?.name).toBe("Mine");
  });

  it("owner can update the value and delete", async () => {
    const a = await createTestUser("bf-owner");
    currentClient = a.client;
    const field = await (await createField(postJson({ name: "Hours", slug: "hours", value: "9-5" }))).json();

    const upd = await updateField(putJson({ value: "10-6" }), fieldParams(field.id));
    expect(upd.status).toBe(200);
    expect((await upd.json()).value).toBe("10-6");

    const del = await deleteField(get(), fieldParams(field.id));
    expect(del.status).toBe(200);
    const { data: gone } = await serviceClient().from("bot_fields").select("id").eq("id", field.id).maybeSingle();
    expect(gone).toBeNull();
  });
});

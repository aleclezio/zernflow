import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { anonClient, serviceClient, createTestUser } from "./helpers";

// Seam: swap the Supabase client factory only — RLS + DB stay real.
let currentClient: SupabaseClient<Database> | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient ?? anonClient(),
  createServiceClient: async () => serviceClient(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { GET as flowExport } from "@/app/api/v1/flows/[flowId]/export/route";
import { POST as flowClone } from "@/app/api/v1/flows/[flowId]/clone/route";
import { POST as flowImport } from "@/app/api/v1/flows/import/route";
import { GET as flowAnalytics } from "@/app/api/v1/flows/[flowId]/analytics/route";
import { GET as contactExport } from "@/app/api/v1/contacts/[contactId]/export/route";
import { GET as dashboardStats } from "@/app/api/v1/dashboard/stats/route";
import { POST as contactsImport } from "@/app/api/v1/contacts/import/route";

const URL = "http://localhost:3000/api/v1/_";
const get = () => new NextRequest(URL);
const postJson = (body: unknown) =>
  new NextRequest(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function seedFlow(workspaceId: string, name = "Test Flow") {
  const { data } = await serviceClient()
    .from("flows")
    .insert({ workspace_id: workspaceId, name, nodes: [{ id: "n1" }], edges: [] })
    .select("id")
    .single();
  return data!.id;
}

beforeEach(() => {
  currentClient = null;
});

describe("flow export", () => {
  it("returns the caller's flow as a portable export", async () => {
    const a = await createTestUser("qw-exp");
    currentClient = a.client;
    const flowId = await seedFlow(a.workspaceId);

    const res = await flowExport(get(), { params: Promise.resolve({ flowId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._format).toBe("zernflow-v1");
    expect(body.nodes).toEqual([{ id: "n1" }]);
  });

  it("cannot export another workspace's flow (404)", async () => {
    const a = await createTestUser("qw-exp-a");
    const b = await createTestUser("qw-exp-b");
    const flowId = await seedFlow(a.workspaceId);
    currentClient = b.client; // B tries A's flow

    const res = await flowExport(get(), { params: Promise.resolve({ flowId }) });
    expect(res.status).toBe(404);
  });
});

describe("flow clone", () => {
  it("clones the caller's flow as a new draft", async () => {
    const a = await createTestUser("qw-clone");
    currentClient = a.client;
    const flowId = await seedFlow(a.workspaceId, "Original");

    const res = await flowClone(postJson({}), { params: Promise.resolve({ flowId }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe(flowId);
    expect(body.status).toBe("draft");
    expect(body.workspace_id).toBe(a.workspaceId);
  });

  it("cannot clone another workspace's flow (404)", async () => {
    const a = await createTestUser("qw-clone-a");
    const b = await createTestUser("qw-clone-b");
    const flowId = await seedFlow(a.workspaceId);
    currentClient = b.client;

    const res = await flowClone(postJson({}), { params: Promise.resolve({ flowId }) });
    expect(res.status).toBe(404);
  });
});

describe("flow import", () => {
  it("creates a draft flow from a valid export", async () => {
    const a = await createTestUser("qw-import");
    currentClient = a.client;

    const res = await flowImport(
      postJson({ _format: "zernflow-v1", name: "Imported", nodes: [{ id: "x" }], edges: [] })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace_id).toBe(a.workspaceId);
    expect(body.status).toBe("draft");
  });

  it("rejects a non-zernflow payload (400)", async () => {
    const a = await createTestUser("qw-import-bad");
    currentClient = a.client;
    const res = await flowImport(postJson({ nope: true }));
    expect(res.status).toBe(400);
  });
});

describe("flow analytics", () => {
  it("returns a summary for the caller's flow", async () => {
    const a = await createTestUser("qw-an");
    currentClient = a.client;
    const flowId = await seedFlow(a.workspaceId);

    const res = await flowAnalytics(get(), { params: Promise.resolve({ flowId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flowId).toBe(flowId);
    expect(body.summary).toHaveProperty("starts");
  });

  it("cannot read another workspace's flow analytics (404)", async () => {
    const a = await createTestUser("qw-an-a");
    const b = await createTestUser("qw-an-b");
    const flowId = await seedFlow(a.workspaceId);
    currentClient = b.client;

    const res = await flowAnalytics(get(), { params: Promise.resolve({ flowId }) });
    expect(res.status).toBe(404);
  });
});

describe("contact GDPR export", () => {
  it("exports the caller's contact data", async () => {
    const a = await createTestUser("qw-gdpr");
    currentClient = a.client;
    const { data: contact } = await serviceClient()
      .from("contacts")
      .insert({ workspace_id: a.workspaceId, display_name: "Jane" })
      .select("id")
      .single();

    const res = await contactExport(get(), { params: Promise.resolve({ contactId: contact!.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contact.id).toBe(contact!.id);
  });

  it("cannot export another workspace's contact (404)", async () => {
    const a = await createTestUser("qw-gdpr-a");
    const b = await createTestUser("qw-gdpr-b");
    const { data: contact } = await serviceClient()
      .from("contacts")
      .insert({ workspace_id: a.workspaceId, display_name: "Jane" })
      .select("id")
      .single();
    currentClient = b.client;

    const res = await contactExport(get(), { params: Promise.resolve({ contactId: contact!.id }) });
    expect(res.status).toBe(404);
  });
});

describe("dashboard stats", () => {
  it("returns counts scoped to the caller's workspace", async () => {
    const a = await createTestUser("qw-stats");
    currentClient = a.client;
    await serviceClient().from("contacts").insert([
      { workspace_id: a.workspaceId, display_name: "C1" },
      { workspace_id: a.workspaceId, display_name: "C2" },
    ]);

    const res = await dashboardStats(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalContacts).toBeGreaterThanOrEqual(2);
  });
});

describe("contacts CSV import", () => {
  it("imports contacts and reports the created count", async () => {
    const a = await createTestUser("qw-csv");
    currentClient = a.client;

    const csv = "name,email,tags\nAlice,alice@test.local,vip\nBob,,\n";
    const fd = new FormData();
    fd.append("file", new File([csv], "contacts.csv", { type: "text/csv" }));
    const req = new NextRequest(URL, { method: "POST", body: fd });

    const res = await contactsImport(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(2);
    expect(body.tagCount).toBeGreaterThanOrEqual(1);
  });
});

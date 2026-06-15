import { test, expect } from "@playwright/test";
import { seedUser, seedFlow, seedApiKey, serviceClient } from "./seed";

// Browser-less but real-HTTP proof of API-key tenant isolation over the v1 surface.
// `request` is a clean context (no session cookies) → pure Bearer-key auth, which
// hits the RLS-bypassing service client. The .eq(workspace_id) gate is the only
// thing standing between B's key and A's data; this spec proves it holds.
test("API-key parity: workspace B's key cannot read or write workspace A's data", async ({ request }) => {
  const userA = await seedUser("parityA");
  const userB = await seedUser("parityB");
  const aFlowId = await seedFlow(userA.workspaceId, "A-only flow");
  const bFlowId = await seedFlow(userB.workspaceId, "B flow");
  const bKey = await seedApiKey(userB.workspaceId, userB.userId);
  const authH = { headers: { Authorization: `Bearer ${bKey}` } };

  // Positive: B's key reads its OWN flows over the service-client path.
  const ownRes = await request.get("/api/v1/flows", authH);
  expect(ownRes.status()).toBe(200);
  const own = (await ownRes.json()) as { id: string }[];
  expect(own.map((f) => f.id)).toContain(bFlowId);

  // Cross-tenant read (list): B never sees A's flow.
  expect(own.map((f) => f.id)).not.toContain(aFlowId);

  // Cross-tenant read (by id): 404, not A's flow.
  const xGet = await request.get(`/api/v1/flows/${aFlowId}`, authH);
  expect(xGet.status()).toBe(404);

  // Cross-tenant write: B's key cannot rename A's flow.
  const xPut = await request.put(`/api/v1/flows/${aFlowId}`, { ...authH, data: { name: "hacked" } });
  expect(xPut.status()).toBe(404);
  const { data: aFlow } = await serviceClient().from("flows").select("name").eq("id", aFlowId).single();
  expect(aFlow!.name).toBe("A-only flow");

  // No key at all → 401.
  const noAuth = await request.get("/api/v1/flows");
  expect(noAuth.status()).toBe(401);
});

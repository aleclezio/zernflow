import { test, expect } from "@playwright/test";
import { seedUser, seedFlow, seedApiKey, serviceClient } from "./seed";

// Real-HTTP proof that per-key scopes are enforced at the v1 surface. A read-only
// key can GET but is 403'd on a write; a write key can do both — which proves the
// 403 is the scope boundary, not a broken route.
test("API-key scopes: a read-only key reads but cannot write; a write key can do both", async ({ request }) => {
  const user = await seedUser("scopes");
  const flowId = await seedFlow(user.workspaceId, "scoped flow");
  const readKey = await seedApiKey(user.workspaceId, user.userId, ["read"]);
  const writeKey = await seedApiKey(user.workspaceId, user.userId, ["read", "write"]);

  // Read-only key: GET works.
  const readOk = await request.get("/api/v1/flows", { headers: { Authorization: `Bearer ${readKey}` } });
  expect(readOk.status()).toBe(200);

  // Read-only key: PUT is rejected with 403 Insufficient scope (no mutation).
  const readWrite = await request.put(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: `Bearer ${readKey}` },
    data: { name: "renamed by read-only" },
  });
  expect(readWrite.status()).toBe(403);
  expect((await readWrite.json()).error).toBe("Insufficient scope");
  const { data: afterReadAttempt } = await serviceClient().from("flows").select("name").eq("id", flowId).single();
  expect(afterReadAttempt!.name).toBe("scoped flow");

  // Write key: PUT succeeds — same route, so the 403 above was the scope, not a 404/500.
  const writeOk = await request.put(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: `Bearer ${writeKey}` },
    data: { name: "renamed by writer" },
  });
  expect(writeOk.status()).toBe(200);
  const { data: afterWrite } = await serviceClient().from("flows").select("name").eq("id", flowId).single();
  expect(afterWrite!.name).toBe("renamed by writer");
});

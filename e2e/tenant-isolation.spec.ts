import { test, expect, loginViaUI } from "./helpers";
import { seedUser } from "./seed";

// Browser-level proof of tenant isolation: a key created in workspace B must
// never surface in workspace A's UI. (The API/RLS path is also covered by the
// integration suite; this guards the rendered surface.)
test("cross-tenant: workspace A cannot see workspace B's API key", async ({ browser }) => {
  const userA = await seedUser("tenantA");
  const userB = await seedUser("tenantB");
  const keyName = `tenantB-key-${Date.now()}`;

  // B issues a key.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await loginViaUI(pageB, userB);
  await pageB.goto("/dashboard/settings/api-keys");
  await pageB.getByRole("button", { name: "New key" }).click();
  await pageB.getByPlaceholder("e.g. Zapier integration").fill(keyName);
  await pageB.getByRole("button", { name: "Create" }).click();
  await expect(pageB.getByText(keyName)).toBeVisible();
  await ctxB.close();

  // A must not see B's key — A's list is empty.
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await loginViaUI(pageA, userA);
  await pageA.goto("/dashboard/settings/api-keys");
  await expect(pageA.getByRole("heading", { name: "API Keys" })).toBeVisible();
  await expect(pageA.getByText(keyName)).toHaveCount(0);
  await expect(pageA.getByText("No API keys yet.")).toBeVisible();
  await ctxA.close();
});

import { test, expect } from "./helpers";
import { seedFlow } from "./seed";

test("create a ref link from a seeded flow", async ({ page, authedUser }) => {
  // Ref links point at a flow, so seed one into this spec's workspace first.
  await seedFlow(authedUser.workspaceId, "E2E Flow");

  await page.goto("/dashboard/growth/ref-links");
  await expect(page.getByRole("heading", { name: /Ref Links/ })).toBeVisible();

  await page.getByRole("button", { name: "New ref link" }).click();
  await page.getByPlaceholder("e.g. Spring promo flyer").fill("E2E Ref Link");
  await page.locator("select").first().selectOption({ label: "E2E Flow" }); // Flow select
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByText("E2E Ref Link")).toBeVisible();
});

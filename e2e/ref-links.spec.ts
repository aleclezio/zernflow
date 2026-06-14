import { test, expect } from "@playwright/test";

// Ref-link creation needs a published flow; a fresh workspace has none, so this
// smoke asserts the page renders and the create form opens with the right guidance.
// Deeper coverage (actual ref-link creation) requires seeding a flow first.
test("ref-links page loads and the create form opens", async ({ page }) => {
  await page.goto("/dashboard/growth/ref-links");
  await expect(page.getByRole("heading", { name: /Ref Links/ })).toBeVisible();

  await page.getByRole("button", { name: "New ref link" }).click();
  await expect(page.getByText(/Create and publish a flow first/i)).toBeVisible();
});

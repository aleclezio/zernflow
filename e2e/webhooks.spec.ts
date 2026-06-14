import { test, expect } from "@playwright/test";

test("creating a webhook endpoint reveals the signing secret once", async ({ page }) => {
  await page.goto("/dashboard/settings/webhooks");
  await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();

  await page.getByRole("button", { name: "New endpoint" }).click();
  await page
    .getByPlaceholder("https://example.com/webhooks/zernflow")
    .fill("https://example.com/e2e-hook");
  await page.getByPlaceholder("e.g. CRM sync").fill("E2E smoke endpoint");
  await page.getByLabel("Contact created").check();
  await page.getByRole("button", { name: "Create endpoint" }).click();

  await expect(page.getByText(/Copy your signing secret now/i)).toBeVisible();
});

import { test, expect } from "@playwright/test";

test("creating a bot field adds it to the list", async ({ page }) => {
  await page.goto("/dashboard/settings/bot-fields");
  await expect(page.getByRole("heading", { name: "Bot Fields" })).toBeVisible();

  await page.getByRole("button", { name: "New field" }).click();
  await page.getByPlaceholder("Business name").fill("E2E Smoke Field");
  await page.getByPlaceholder("business_name").fill("e2e_smoke_field");
  await page.getByPlaceholder("Acme Inc.").fill("smoke value");
  await page.getByRole("button", { name: "Create" }).click();

  // The new row shows the slug token; the create form resets + closes.
  await expect(page.getByText("e2e_smoke_field")).toBeVisible();
});

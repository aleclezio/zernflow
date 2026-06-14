import { test, expect } from "@playwright/test";

test("creating an API key reveals the secret once", async ({ page }) => {
  await page.goto("/dashboard/settings/api-keys");
  await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();

  await page.getByRole("button", { name: "New key" }).click();
  await page.getByPlaceholder("e.g. Zapier integration").fill("E2E smoke key");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByText(/Copy your key now/i)).toBeVisible();
});

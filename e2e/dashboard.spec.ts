import { test, expect } from "@playwright/test";

test("dashboard loads for an authenticated user", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);
  // Missing session would bounce us to /login (which has the #email field).
  await expect(page.locator("#email")).toHaveCount(0);
});

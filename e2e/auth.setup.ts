import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { seedUser } from "./seed";

const authFile = path.join("e2e", ".auth", "user.json");

// Seed a fresh user, log in through the real UI once, and persist the session
// so every other spec reuses it (storageState) instead of re-driving login.
setup("authenticate", async ({ page }) => {
  const user = await seedUser("auth");

  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // A successful sign-in client-routes to /dashboard.
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/dashboard/);

  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});

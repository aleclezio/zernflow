import { test as base, expect, type Page } from "@playwright/test";
import { seedUser, type SeededUser } from "./seed";

/** Drive the real login UI for a seeded user, landing on /dashboard. */
export async function loginViaUI(
  page: Page,
  user: Pick<SeededUser, "email" | "password">,
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Specs that use this `test` get an `authedUser` fixture: a fresh seeded
 * user + workspace, already logged in on `page`. Isolating every spec to its
 * own workspace makes the suite retry-safe and order-independent (no shared
 * state, no empty-state preconditions one spec can break for another).
 */
export const test = base.extend<{ authedUser: SeededUser }>({
  // Param is named `provide` (not Playwright's usual `use`) so the react-hooks
  // lint rule doesn't mistake the call for a React Hook.
  authedUser: async ({ page }, provide) => {
    const user = await seedUser("spec");
    await loginViaUI(page, user);
    await provide(user);
  },
});

export { expect };

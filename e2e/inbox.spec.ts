import { test, expect } from "@playwright/test";

// Notes & saved-replies live inside the inbox conversation view, which needs a
// seeded conversation. This smoke asserts the inbox itself loads authenticated;
// note/saved-reply CRUD is deferred to a comprehensive pass with seeded data.
test("inbox loads for an authenticated user", async ({ page }) => {
  await page.goto("/dashboard/inbox");
  await expect(page).toHaveURL(/\/inbox/);
  await expect(page.locator("#email")).toHaveCount(0);
});

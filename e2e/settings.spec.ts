import { test, expect } from "./helpers";
import type { Page } from "@playwright/test";

// The workspace Name input has no associated label/placeholder — scope it to the
// General section so the round-robin save (which requires a non-empty name) works.
function workspaceNameInput(page: Page) {
  return page
    .locator("section")
    .filter({ hasText: "Workspace Name" })
    .locator('input[type="text"]')
    .first();
}

test("round-robin assignment toggle persists", async ({ page, authedUser }) => {
  expect(authedUser.workspaceId).toBeTruthy();
  await page.goto("/dashboard/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Save Changes is disabled unless the workspace name is non-empty.
  await workspaceNameInput(page).fill("E2E Workspace");

  const toggle = page
    .locator("label")
    .filter({ hasText: "Round-robin assignment" })
    .getByRole("checkbox");
  await toggle.check();
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  // Persisted server-side: a reload re-hydrates it checked.
  await page.reload();
  await expect(
    page.locator("label").filter({ hasText: "Round-robin assignment" }).getByRole("checkbox"),
  ).toBeChecked();
});

test("AI intent recognition toggle responds", async ({ page, authedUser }) => {
  expect(authedUser.workspaceId).toBeTruthy();
  await page.goto("/dashboard/settings");
  const toggle = page
    .locator("label")
    .filter({ hasText: "AI intent recognition" })
    .getByRole("checkbox");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
});

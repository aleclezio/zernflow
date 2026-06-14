import { test, expect } from "./helpers";

test("API key lifecycle: create, rotate, revoke", async ({ page, authedUser }) => {
  expect(authedUser.workspaceId).toBeTruthy();
  page.on("dialog", (d) => d.accept()); // rotate + revoke use window.confirm()
  const name = `crud-key-${Date.now()}`;

  await page.goto("/dashboard/settings/api-keys");
  await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();

  // CREATE → secret shown once
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByPlaceholder("e.g. Zapier integration").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(/Copy your key now/i)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText(name)).toBeVisible();

  // ROTATE → a fresh secret is revealed
  await page.getByRole("button", { name: "Rotate" }).click();
  await expect(page.getByText(/Copy your key now/i)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();

  // REVOKE → the key is gone
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText(name)).toHaveCount(0);
  await expect(page.getByText("No API keys yet.")).toBeVisible();
});

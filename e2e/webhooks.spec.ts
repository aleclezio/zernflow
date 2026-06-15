import { test, expect } from "./helpers";

test("webhook endpoint lifecycle: create, toggle, delete", async ({ page, authedUser }) => {
  expect(authedUser.workspaceId).toBeTruthy();
  page.on("dialog", (d) => d.accept()); // delete uses window.confirm()
  const name = `crud-hook-${Date.now()}`;

  await page.goto("/dashboard/settings/webhooks");
  await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();

  // CREATE → signing secret shown once
  await page.getByRole("button", { name: "New endpoint" }).click();
  await page
    .getByPlaceholder("https://example.com/webhooks/zernflow")
    .fill("https://example.com/e2e-crud");
  await page.getByPlaceholder("e.g. CRM sync").fill(name);
  await page.getByLabel("Contact created").check();
  await page.getByRole("button", { name: "Create endpoint" }).click();
  await expect(page.getByText(/Copy your signing secret now/i)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText(name)).toBeVisible();

  // TOGGLE active → Disable flips to Enable
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByRole("button", { name: "Enable" })).toBeVisible();

  // DELETE → the endpoint is gone
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(name)).toHaveCount(0);
  await expect(page.getByText("No webhook endpoints yet.")).toBeVisible();
});

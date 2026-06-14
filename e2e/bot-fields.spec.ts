import { test, expect } from "./helpers";

test("bot field lifecycle: create, edit value, delete", async ({ page, authedUser }) => {
  expect(authedUser.workspaceId).toBeTruthy();
  const slug = `crud_field_${Date.now()}`;

  await page.goto("/dashboard/settings/bot-fields");
  await expect(page.getByRole("heading", { name: "Bot Fields" })).toBeVisible();

  // CREATE
  await page.getByRole("button", { name: "New field" }).click();
  await page.getByPlaceholder("Business name").fill("CRUD Field");
  await page.getByPlaceholder("business_name").fill(slug);
  await page.getByPlaceholder("Acme Inc.").fill("v1");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(slug)).toBeVisible();

  // EDIT value (fresh workspace → exactly one row → one textbox), then reload to
  // prove persistence. Wait for the PUT to resolve before reloading, else the
  // reload can race the save and read the stale value.
  await page.getByRole("textbox").fill("v2");
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/v1/bot-fields/") && r.request().method() === "PUT" && r.ok(),
  );
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("v2");

  // DELETE (no confirm dialog)
  await page.getByRole("button", { name: "Delete bot field" }).click();
  await expect(page.getByText(slug)).toHaveCount(0);
  await expect(page.getByText("No bot fields yet.", { exact: false })).toBeVisible();
});

import { test, expect } from "./helpers";
import { seedConversation, seedSavedReply } from "./seed";

test("inbox: add a note and insert a saved reply", async ({ page, authedUser }) => {
  const contactName = `E2E Contact ${Date.now()}`;
  await seedConversation(authedUser.workspaceId, contactName);
  await seedSavedReply(authedUser.workspaceId, "E2E Greeting", "Hello from a saved reply");

  await page.goto("/dashboard/inbox");
  // Open the seeded conversation (each list row is a button labelled by contact).
  await page.locator("button").filter({ hasText: contactName }).click();

  // NOTES (right contact panel)
  const noteInput = page.getByPlaceholder(/Add an internal note/);
  await expect(noteInput).toBeVisible();
  const noteText = `E2E note ${Date.now()}`;
  await noteInput.fill(noteText);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText(noteText)).toBeVisible();

  // SAVED REPLIES (composer picker)
  await page.getByRole("button", { name: "Saved replies" }).click();
  await expect(page.getByText("E2E Greeting")).toBeVisible();
  await page.getByText("E2E Greeting").click();
  await expect(page.getByPlaceholder("Type a message...")).toHaveValue(/Hello from a saved reply/);
});

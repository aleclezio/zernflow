import { describe, it, expect } from "vitest";
import { serviceClient, createTestUser } from "./helpers";

describe("local stack sanity", () => {
  it("migrations applied: core tables exist", async () => {
    const supabase = serviceClient();
    for (const table of ["workspaces", "channels", "flows", "scheduled_jobs"] as const) {
      const { error } = await supabase.from(table).select("*").limit(1);
      expect(error, `table ${table}`).toBeNull();
    }
  });

  it("signup trigger creates a workspace with owner membership", async () => {
    const user = await createTestUser("sanity");
    expect(user.workspaceId).toBeTruthy();
    expect(user.role).toBe("owner");
  });

  it("RLS: a user cannot read another user's workspace", async () => {
    const alice = await createTestUser("alice");
    const mallory = await createTestUser("mallory");

    const { data } = await mallory.client
      .from("workspaces")
      .select("id")
      .eq("id", alice.workspaceId);

    expect(data).toEqual([]);
  });
});

import { createClient } from "@supabase/supabase-js";

// Standalone seed helper for e2e (no @ alias, so Playwright's runtime resolves it
// without tsconfig-paths). Mirrors tests/integration/helpers.ts createTestUser.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export interface SeededUser {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
}

/**
 * Create a confirmed user via the admin API and wait for the
 * on_auth_user_created trigger to provision its workspace + owner membership.
 */
export async function seedUser(label = "e2e"): Promise<SeededUser> {
  if (!url || !serviceKey || !anonKey) {
    throw new Error(
      "Missing Supabase env. Run `node scripts/dev-env.mjs` after `npx supabase start` " +
        "(needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY).",
    );
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const email = `e2e-${Date.now()}-${label}@test.local`;
  const password = `pw-${crypto.randomUUID()}`;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`seedUser: createUser failed — ${error?.message ?? "no user returned"}`);
  }
  const userId = data.user.id;

  // The trigger fires asynchronously; poll for the membership row. Tolerant of
  // Docker clock skew like the integration helper.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: member } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    const workspaceId = member?.workspace_id;
    if (workspaceId) {
      return { email, password, userId, workspaceId };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("seedUser: workspace was not created by the trigger after retries");
}

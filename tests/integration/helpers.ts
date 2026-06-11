import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

export function serviceClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}

let userCounter = 0;

/**
 * Create a confirmed test user via the admin API and return a client
 * authenticated as that user, plus their auto-created workspace
 * (the on_auth_user_created trigger creates workspace + owner membership).
 */
export async function createTestUser(label: string) {
  const admin = serviceClient();
  const email = `it-${Date.now()}-${userCounter++}-${label}@test.local`;
  const password = `pw-${crypto.randomUUID()}`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`createTestUser failed: ${createErr?.message}`);
  }

  // Docker Desktop's container clock can drift behind the host after sleep,
  // making fresh JWTs look issued-in-the-future. Retry transient auth skew.
  let client = anonClient();
  let membership: { workspace_id: string; role: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    client = anonClient();
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`);

    const { data, error: memErr } = await client
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", created.user.id)
      .single();

    if (data) {
      membership = data;
      break;
    }
    if (!memErr?.message?.includes("future")) {
      throw new Error(`workspace lookup failed: ${memErr?.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!membership) {
    throw new Error("workspace lookup failed: clock skew persisted after retries");
  }

  return {
    userId: created.user.id,
    email,
    client,
    workspaceId: membership.workspace_id,
    role: membership.role,
  };
}

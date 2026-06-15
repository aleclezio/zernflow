import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

// Standalone seed helpers for e2e (no @ alias, so Playwright's runtime resolves
// them without tsconfig-paths). The service client mirrors
// tests/integration/helpers.ts and is used to provision per-spec fixtures.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const MISSING_ENV =
  "Missing Supabase env. Run `node scripts/dev-env.mjs` after `npx supabase start` " +
  "(needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY).";

let seq = 0;

export function serviceClient(): SupabaseClient {
  if (!url || !serviceKey) throw new Error(MISSING_ENV);
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

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
  if (!anonKey) throw new Error(MISSING_ENV);
  const admin = serviceClient();
  const email = `e2e-${Date.now()}-${seq++}-${label}@test.local`;
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

  // The trigger fires asynchronously; poll for the membership row.
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

/** Insert a flow (defaults: status 'draft', empty nodes/edges) and return its id. */
export async function seedFlow(workspaceId: string, name = "E2E Flow"): Promise<string> {
  const { data, error } = await serviceClient()
    .from("flows")
    .insert({ workspace_id: workspaceId, name })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedFlow failed: ${error?.message}`);
  return data.id as string;
}

export interface SeededConversation {
  channelId: string;
  contactId: string;
  conversationId: string;
  contactName: string;
}

/** Seed a channel + contact + open conversation so the inbox has something to open. */
export async function seedConversation(
  workspaceId: string,
  contactName = "E2E Contact",
): Promise<SeededConversation> {
  const db = serviceClient();

  const { data: channel, error: chErr } = await db
    .from("channels")
    .insert({
      workspace_id: workspaceId,
      platform: "instagram",
      late_account_id: `e2e-acct-${Date.now()}-${seq++}`,
    })
    .select("id")
    .single();
  if (chErr || !channel) throw new Error(`seedConversation: channel failed — ${chErr?.message}`);

  const { data: contact, error: ctErr } = await db
    .from("contacts")
    .insert({ workspace_id: workspaceId, display_name: contactName })
    .select("id")
    .single();
  if (ctErr || !contact) throw new Error(`seedConversation: contact failed — ${ctErr?.message}`);

  const { data: conv, error: cvErr } = await db
    .from("conversations")
    .insert({
      workspace_id: workspaceId,
      channel_id: channel.id,
      contact_id: contact.id,
      platform: "instagram",
      status: "open",
    })
    .select("id")
    .single();
  if (cvErr || !conv) throw new Error(`seedConversation: conversation failed — ${cvErr?.message}`);

  return {
    channelId: channel.id,
    contactId: contact.id,
    conversationId: conv.id,
    contactName,
  };
}

/**
 * Insert an API key for a workspace and return the RAW `zf_` secret.
 * Mirrors lib/api-key.ts: the stored hash is sha256(raw) (hex). Lets e2e drive
 * the real Bearer-auth HTTP path without scraping the shown-once UI value.
 * `scopes` is optional — omit it to get a full-access key (DB default).
 */
export async function seedApiKey(
  workspaceId: string,
  createdBy: string,
  scopes?: string[],
): Promise<string> {
  const raw = `zf_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const { error } = await serviceClient().from("api_keys").insert({
    workspace_id: workspaceId,
    name: "e2e parity key",
    key_hash: createHash("sha256").update(raw).digest("hex"),
    key_prefix: raw.slice(0, 12) + "...",
    created_by: createdBy,
    ...(scopes ? { scopes } : {}),
  });
  if (error) throw new Error(`seedApiKey failed: ${error.message}`);
  return raw;
}

/** Insert a saved reply (surfaced in the inbox composer picker) and return its id. */
export async function seedSavedReply(
  workspaceId: string,
  title: string,
  content: string,
): Promise<string> {
  const { data, error } = await serviceClient()
    .from("saved_replies")
    .insert({ workspace_id: workspaceId, title, content })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedSavedReply failed: ${error?.message}`);
  return data.id as string;
}

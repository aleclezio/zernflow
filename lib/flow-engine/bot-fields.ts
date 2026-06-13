import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

/**
 * Map workspace bot fields into the {{bot.<slug>}} interpolation namespace.
 * Pure + side-effect-free so it is unit-tested without a DB.
 */
export function botFieldVars(
  fields: Array<{ slug: string; value: string }>
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const f of fields) vars[`bot.${f.slug}`] = f.value;
  return vars;
}

/**
 * Load a workspace's bot fields as {{bot.<slug>}} interpolation variables.
 * Loaded fresh per flow execution (workspace-global, not session state) so
 * values are always current and never persisted into a flow session.
 */
export async function loadBotFieldVars(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<Record<string, string>> {
  const { data } = await supabase
    .from("bot_fields")
    .select("slug, value")
    .eq("workspace_id", workspaceId);
  return botFieldVars(data ?? []);
}

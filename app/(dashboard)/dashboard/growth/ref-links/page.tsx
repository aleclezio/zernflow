import { getWorkspace } from "@/lib/workspace";
import { RefLinksView } from "./ref-links-view";

export default async function RefLinksPage() {
  const { workspace, supabase } = await getWorkspace();

  const [{ data: refLinks }, { data: flows }, { data: channels }] = await Promise.all([
    supabase
      .from("ref_links")
      .select("*, flows(name, status)")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("flows")
      .select("id, name")
      .eq("workspace_id", workspace.id)
      .order("name", { ascending: true }),
    supabase
      .from("channels")
      .select("id, platform, username")
      .eq("workspace_id", workspace.id)
      .eq("is_active", true)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <RefLinksView
      initialRefLinks={refLinks ?? []}
      flows={flows ?? []}
      channels={channels ?? []}
    />
  );
}

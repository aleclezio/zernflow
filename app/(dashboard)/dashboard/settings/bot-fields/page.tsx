import { getWorkspace } from "@/lib/workspace";
import { BotFieldsView } from "./bot-fields-view";

export default async function BotFieldsPage() {
  const { workspace, supabase } = await getWorkspace();

  const { data: fields } = await supabase
    .from("bot_fields")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: true });

  return <BotFieldsView initialFields={fields ?? []} />;
}

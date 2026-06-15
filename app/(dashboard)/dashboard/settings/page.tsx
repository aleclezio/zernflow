import { getWorkspace } from "@/lib/workspace";
import { workspaceKeyStatus } from "@/lib/workspace-keys";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  const { workspace } = await getWorkspace();
  const { hasApiKey, hasAiKey } = workspaceKeyStatus(workspace);

  return (
    <SettingsView
      workspace={{
        id: workspace.id,
        name: workspace.name,
        hasApiKey,
        hasAiKey,
        aiIntentEnabled: workspace.ai_intent_enabled,
        autoAssignMode: workspace.auto_assign_mode,
        globalKeywords: (workspace.global_keywords as string[]) ?? [],
      }}
    />
  );
}

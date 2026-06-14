import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/workspace";
import { ApiKeysView } from "./api-keys-view";

export default async function ApiKeysPage() {
  const { workspace, role, supabase } = await getWorkspace();
  const isAdmin = role === "owner" || role === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-8">
        <Link
          href="/dashboard/settings"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Settings
        </Link>
        <p className="mt-6 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Only workspace owners and admins can manage API keys.
        </p>
      </div>
    );
  }

  const { data: keys } = await supabase
    .from("api_keys")
    .select("id, name, key_prefix, last_used_at, expires_at, created_at")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  return <ApiKeysView initialKeys={keys ?? []} />;
}

import { createServiceClient } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import { dmUrlForChannel } from "@/lib/ref-links";

/**
 * Public ref-link landing page (no auth — used by QR scans / shared URLs).
 *
 * 1. Look up the ref_link by slug with the service client (anon visitor, RLS bypassed).
 * 2. 404 if missing or inactive.
 * 3. Increment the click counter atomically (service-role-only RPC).
 * 4. Redirect to the channel's DM deep-link if one is available; otherwise
 *    render a minimal landing page.
 */
export default async function RefLinkPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await createServiceClient();

  const { data: link } = await supabase
    .from("ref_links")
    .select("id, is_active, channels(platform, username)")
    .eq("slug", slug)
    .single();

  if (!link || !link.is_active) return notFound();

  await supabase.rpc("increment_ref_link_clicks", { link_id: link.id });

  const channel = link.channels as { platform: string; username: string | null } | null;
  const dmUrl = channel ? dmUrlForChannel(channel.platform, channel.username) : null;
  if (dmUrl) redirect(dmUrl);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900">Start a conversation</h1>
        <p className="mt-2 text-gray-600">This link is ready to connect you.</p>
      </div>
    </div>
  );
}

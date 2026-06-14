import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceAdmin } from "@/lib/api-auth";
import { getWebhookEndpointSecret } from "@/lib/workspace-keys";
import { buildWebhookPayload, signWebhookPayload, isDeliverySuccess } from "@/lib/webhook-events";
import { safeFetch, SsrfError } from "@/lib/flow-engine/safe-fetch";

/**
 * POST /api/v1/webhook-endpoints/:endpointId/test — deliver a signed test event to
 * the endpoint and report the HTTP status. Goes through safe-fetch (the URL is
 * customer-authored), so a private/reserved target is refused, not delivered.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data: endpoint } = await supabase
    .from("webhook_endpoints")
    .select("id, url")
    .eq("id", endpointId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!endpoint) return NextResponse.json({ error: "Webhook endpoint not found" }, { status: 404 });

  const secret = await getWebhookEndpointSecret(supabase, auth.workspaceId, endpointId);
  const body = JSON.stringify(
    buildWebhookPayload("test", { message: "This is a test event from Zernflow" }, new Date().toISOString())
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Zernflow-Webhook/1.0",
  };
  if (secret) headers["X-Zernflow-Signature"] = signWebhookPayload(body, secret);

  try {
    const { status } = await safeFetch(endpoint.url, { method: "POST", headers, body });
    return NextResponse.json({ success: isDeliverySuccess(status), statusCode: status });
  } catch (err) {
    const error =
      err instanceof SsrfError
        ? "Endpoint URL is not allowed (it must resolve to a public address)"
        : "Delivery failed";
    return NextResponse.json({ success: false, error });
  }
}

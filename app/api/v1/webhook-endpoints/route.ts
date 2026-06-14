import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceAdmin } from "@/lib/api-auth";
import { setWebhookEndpointSecret } from "@/lib/workspace-keys";
import { WEBHOOK_EVENTS, isValidWebhookEvent, generateWebhookSecret } from "@/lib/webhook-events";

// Metadata only — never the signing secret (kept encrypted, shown once at create).
const SELECT_PUBLIC =
  "id, url, name, events, is_active, last_triggered_at, failure_count, created_at, updated_at";

/** GET /api/v1/webhook-endpoints — list the workspace's outbound webhook endpoints. */
export async function GET(request: NextRequest) {
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data, error } = await supabase
    .from("webhook_endpoints")
    .select(SELECT_PUBLIC)
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "Failed to load webhook endpoints" }, { status: 500 });
  return NextResponse.json({ data });
}

/**
 * POST /api/v1/webhook-endpoints — register an endpoint.
 * Body: { url (https), name, events[], secret? }. A signing secret is
 * auto-generated when none is supplied (deliveries are signed by default); the
 * effective secret is returned ONCE here and never shown again.
 */
export async function POST(request: NextRequest) {
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url || !url.startsWith("https://")) {
    return NextResponse.json({ error: "url is required and must start with https://" }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (name.length > 200) return NextResponse.json({ error: "name is too long" }, { status: 400 });

  if (!Array.isArray(body?.events) || body.events.length === 0) {
    return NextResponse.json({ error: "events must be a non-empty array" }, { status: 400 });
  }
  const invalid = body.events.filter((e: unknown) => typeof e !== "string" || !isValidWebhookEvent(e));
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Invalid event types: ${invalid.join(", ")}. Valid: ${WEBHOOK_EVENTS.join(", ")}` },
      { status: 400 }
    );
  }

  const provided =
    typeof body?.secret === "string" && body.secret.length > 0 ? body.secret : null;
  const secret = provided ?? generateWebhookSecret();

  const { data, error } = await supabase
    .from("webhook_endpoints")
    .insert({ workspace_id: auth.workspaceId, url, name, events: body.events })
    .select(SELECT_PUBLIC)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Failed to create webhook endpoint" }, { status: 500 });
  }

  const { error: secretErr } = await setWebhookEndpointSecret(
    supabase,
    auth.workspaceId,
    data.id,
    secret
  );
  if (secretErr) {
    // Roll back the half-created endpoint so it can't deliver unsigned/unconfigured.
    await supabase.from("webhook_endpoints").delete().eq("id", data.id).eq("workspace_id", auth.workspaceId);
    return NextResponse.json({ error: "Failed to create webhook endpoint" }, { status: 500 });
  }

  // The signing secret is shown exactly once here.
  return NextResponse.json({ data, secret }, { status: 201 });
}

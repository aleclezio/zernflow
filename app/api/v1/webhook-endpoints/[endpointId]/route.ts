import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceAdmin } from "@/lib/api-auth";
import { setWebhookEndpointSecret } from "@/lib/workspace-keys";
import { WEBHOOK_EVENTS, isValidWebhookEvent } from "@/lib/webhook-events";
import type { Database } from "@/lib/types/database";

const SELECT_PUBLIC =
  "id, url, name, events, is_active, last_triggered_at, failure_count, created_at, updated_at";

/**
 * PUT /api/v1/webhook-endpoints/:endpointId — update url/name/events/is_active and/or
 * the signing secret. `secret: null | ""` clears it (deliveries become unsigned);
 * a non-empty string replaces it.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const updates: Database["public"]["Tables"]["webhook_endpoints"]["Update"] = {};

  if (body?.url !== undefined) {
    if (typeof body.url !== "string" || !body.url.trim().startsWith("https://")) {
      return NextResponse.json({ error: "url must start with https://" }, { status: 400 });
    }
    updates.url = body.url.trim();
  }
  if (body?.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    if (body.name.trim().length > 200) {
      return NextResponse.json({ error: "name is too long" }, { status: 400 });
    }
    updates.name = body.name.trim();
  }
  if (body?.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return NextResponse.json({ error: "events must be a non-empty array" }, { status: 400 });
    }
    const invalid = body.events.filter((e: unknown) => typeof e !== "string" || !isValidWebhookEvent(e));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Invalid event types: ${invalid.join(", ")}. Valid: ${WEBHOOK_EVENTS.join(", ")}` },
        { status: 400 }
      );
    }
    updates.events = body.events;
  }
  if (body?.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return NextResponse.json({ error: "is_active must be a boolean" }, { status: 400 });
    }
    updates.is_active = body.is_active;
    if (body.is_active) updates.failure_count = 0; // re-enabling clears the failure streak
  }

  const hasSecret = Object.prototype.hasOwnProperty.call(body, "secret");
  if (Object.keys(updates).length === 0 && !hasSecret) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  if (Object.keys(updates).length > 0) {
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .update(updates)
      .eq("id", endpointId)
      .eq("workspace_id", auth.workspaceId)
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Failed to update webhook endpoint" }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Webhook endpoint not found" }, { status: 404 });
  }

  if (hasSecret) {
    const raw = body.secret;
    const plaintext = typeof raw === "string" && raw.length > 0 ? raw : null;
    const { error } = await setWebhookEndpointSecret(supabase, auth.workspaceId, endpointId, plaintext);
    if (error) return NextResponse.json({ error: "Webhook endpoint not found" }, { status: 404 });
  }

  const { data: fresh } = await supabase
    .from("webhook_endpoints")
    .select(SELECT_PUBLIC)
    .eq("id", endpointId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!fresh) return NextResponse.json({ error: "Webhook endpoint not found" }, { status: 404 });
  return NextResponse.json({ data: fresh });
}

/** DELETE /api/v1/webhook-endpoints/:endpointId — remove an endpoint. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await params;
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data, error } = await supabase
    .from("webhook_endpoints")
    .delete()
    .eq("id", endpointId)
    .eq("workspace_id", auth.workspaceId)
    .select("id");

  if (error) return NextResponse.json({ error: "Failed to delete webhook endpoint" }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Webhook endpoint not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

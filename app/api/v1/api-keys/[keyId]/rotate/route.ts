import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceAdmin } from "@/lib/api-auth";
import { generateApiKey, hashApiKey, keyPrefix } from "@/lib/api-key";

const SELECT_PUBLIC = "id, name, key_prefix, last_used_at, expires_at, created_at";

/**
 * POST /api/v1/api-keys/:keyId/rotate — rotate a key in place: generate a new
 * secret on the same row (new key_hash + key_prefix), invalidating the old secret
 * immediately. Body: { expiresAt? (ISO) } optionally resets the expiry. The new
 * full key is returned ONCE.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> }
) {
  const { keyId } = await params;
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const update: { key_hash: string; key_prefix: string; expires_at?: string | null } = {
    key_hash: "",
    key_prefix: "",
  };
  if (body?.expiresAt !== undefined) {
    if (body.expiresAt === null || body.expiresAt === "") {
      update.expires_at = null;
    } else {
      const t = Date.parse(String(body.expiresAt));
      if (Number.isNaN(t)) return NextResponse.json({ error: "expiresAt is not a valid date" }, { status: 400 });
      update.expires_at = new Date(t).toISOString();
    }
  }

  const raw = generateApiKey();
  update.key_hash = hashApiKey(raw);
  update.key_prefix = keyPrefix(raw);

  const { data, error } = await supabase
    .from("api_keys")
    .update(update)
    .eq("id", keyId)
    .eq("workspace_id", auth.workspaceId)
    .select(SELECT_PUBLIC)
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Failed to rotate API key" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "API key not found" }, { status: 404 });
  // The new raw key is shown exactly once here.
  return NextResponse.json({ ...data, key: raw });
}

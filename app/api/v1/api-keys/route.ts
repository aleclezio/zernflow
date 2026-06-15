import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceAdmin } from "@/lib/api-auth";
import { generateApiKey, hashApiKey, keyPrefix, parseScopes, type ApiScope } from "@/lib/api-key";

const SELECT_PUBLIC = "id, name, key_prefix, scopes, last_used_at, expires_at, created_at";

/** GET /api/v1/api-keys — list the workspace's keys (metadata only; never the secret). */
export async function GET(request: NextRequest) {
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data, error } = await supabase
    .from("api_keys")
    .select(SELECT_PUBLIC)
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "Failed to load API keys" }, { status: 500 });
  return NextResponse.json({ data });
}

/**
 * POST /api/v1/api-keys — issue a new key. Body: { name, scopes?, expiresAt? (ISO) }.
 * scopes defaults to ["read"] (least privilege) when omitted; an explicit list is
 * validated against read/write/send. The full key is returned ONCE in the
 * response and never stored or shown again.
 */
export async function POST(request: NextRequest) {
  const gate = await requireWorkspaceAdmin(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (name.length > 100) return NextResponse.json({ error: "name is too long" }, { status: 400 });

  // Least-privilege default: a new key is read-only unless scopes are given.
  let scopes: ApiScope[] = ["read"];
  if (body?.scopes !== undefined) {
    const parsed = parseScopes(body.scopes);
    if (!parsed) {
      return NextResponse.json(
        { error: "scopes must be a non-empty subset of read, write, send" },
        { status: 400 }
      );
    }
    scopes = parsed;
  }

  let expiresAt: string | null = null;
  if (body?.expiresAt != null && body.expiresAt !== "") {
    const t = Date.parse(String(body.expiresAt));
    if (Number.isNaN(t)) return NextResponse.json({ error: "expiresAt is not a valid date" }, { status: 400 });
    expiresAt = new Date(t).toISOString();
  }

  const raw = generateApiKey();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      workspace_id: auth.workspaceId,
      name,
      key_hash: hashApiKey(raw),
      key_prefix: keyPrefix(raw),
      scopes,
      expires_at: expiresAt,
      created_by: auth.userId,
    })
    .select(SELECT_PUBLIC)
    .single();

  if (error || !data) return NextResponse.json({ error: "Failed to issue API key" }, { status: 500 });
  // The raw key is shown exactly once here.
  return NextResponse.json({ ...data, key: raw }, { status: 201 });
}

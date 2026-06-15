import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/** slug is used directly in flow templates as {{bot.slug}} — keep it clean. */
const SLUG_RE = /^[a-z][a-z0-9_]*$/;

/** GET /api/v1/bot-fields — list the workspace's bot fields (oldest first). */
export async function GET(request: NextRequest) {
  const gate = await authorizeApiV1(request, "read");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data, error } = await supabase
    .from("bot_fields")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: "Failed to load bot fields" }, { status: 500 });
  return NextResponse.json({ data });
}

/** POST /api/v1/bot-fields — create a bot field. Body: { name, slug, value?, description? }. */
export async function POST(request: NextRequest) {
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const body = await request.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";

  if (!name || !slug) {
    return NextResponse.json({ error: "name and slug are required" }, { status: 400 });
  }
  if (!SLUG_RE.test(slug) || slug.length > 64) {
    return NextResponse.json(
      { error: "slug must start with a letter and contain only lowercase letters, numbers, and underscores" },
      { status: 400 }
    );
  }
  if (name.length > 200 || value.length > 10000 || description.length > 500) {
    return NextResponse.json({ error: "Field exceeds maximum length" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("bot_fields")
    .insert({
      workspace_id: auth.workspaceId,
      name,
      slug,
      value,
      description: description || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "A bot field with this slug already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create bot field" }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}

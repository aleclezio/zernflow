import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

/**
 * GET /api/v1/contacts/:contactId/export
 * GDPR data export: all stored data for one contact (record, channels, tags,
 * custom fields, conversations, messages, sequence enrollments) as a JSON file.
 * Active-workspace scoped; the contact must belong to the caller's workspace.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const { contactId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  // ISOLATION INVARIANT: the contact above is workspace-verified, and every fetch
  // below chains off its id (contact_id / its own conversation ids) — so all rows
  // belong to that contact's workspace. Keep it that way: never fetch related data
  // by anything other than this verified contact's own ids.
  const [channels, tags, customFields, conversations, enrollments] = await Promise.all([
    supabase.from("contact_channels").select("*").eq("contact_id", contactId),
    supabase.from("contact_tags").select("*, tags(name, color)").eq("contact_id", contactId),
    supabase
      .from("contact_custom_fields")
      .select("*, custom_field_definitions(name, slug, type)")
      .eq("contact_id", contactId),
    supabase.from("conversations").select("*").eq("contact_id", contactId),
    supabase.from("sequence_enrollments").select("*, sequences(name)").eq("contact_id", contactId),
  ]);

  const conversationIds = (conversations.data ?? []).map((c) => c.id);
  let messages: unknown[] = [];
  if (conversationIds.length > 0) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("*")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: true });
    messages = msgs ?? [];
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    contact,
    channels: channels.data ?? [],
    tags: tags.data ?? [],
    customFields: customFields.data ?? [],
    conversations: conversations.data ?? [],
    messages,
    sequenceEnrollments: enrollments.data ?? [],
  };

  return new NextResponse(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="contact-${contactId}-export.json"`,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticateRequest } from "@/lib/api-auth";

export const maxDuration = 30;

/**
 * POST /api/v1/contacts/import  (multipart: field "file" = CSV)
 * Columns (case-insensitive headers): name/display_name (required), email
 * (optional), tags (optional, comma-separated). Batched 50 at a time.
 * Active-workspace scoped.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = auth.workspaceId;

  const supabase = await createClient();
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json(
      { error: "No file provided. Send a CSV file as 'file' in multipart form data." },
      { status: 400 }
    );
  }
  if (!file.name.endsWith(".csv")) {
    return NextResponse.json({ error: "Only CSV files are supported." }, { status: 400 });
  }

  const rows = parseCSV(await file.text());
  if (rows.length < 2) {
    return NextResponse.json(
      { error: "CSV must have a header row and at least one data row." },
      { status: 400 }
    );
  }

  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const dataRows = rows.slice(1);
  const nameIdx = headers.findIndex((h) => h === "name" || h === "display_name" || h === "displayname");
  const emailIdx = headers.findIndex((h) => h === "email" || h === "email_address");
  const tagsIdx = headers.findIndex((h) => h === "tags" || h === "tag");

  if (nameIdx === -1) {
    return NextResponse.json(
      { error: "CSV must have a 'name' or 'display_name' column." },
      { status: 400 }
    );
  }

  let created = 0;
  let skipped = 0;
  let tagCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < dataRows.length; i += 50) {
    const batch = dataRows.slice(i, i + 50);

    const contactInserts = batch
      .map((row) => {
        const name = row[nameIdx]?.trim();
        if (!name) {
          skipped++;
          return null;
        }
        return {
          workspace_id: workspaceId,
          display_name: name,
          email: emailIdx !== -1 ? row[emailIdx]?.trim() || null : null,
          is_subscribed: true,
        };
      })
      .filter((c): c is { workspace_id: string; display_name: string; email: string | null; is_subscribed: boolean } => c !== null);

    if (contactInserts.length === 0) continue;

    const { data: insertedContacts, error } = await supabase
      .from("contacts")
      .insert(contactInserts)
      .select("id, display_name");

    if (error) {
      errors.push(`Batch ${Math.floor(i / 50) + 1}: failed`);
      continue;
    }
    created += (insertedContacts ?? []).length;

    if (tagsIdx !== -1 && insertedContacts) {
      for (let j = 0; j < batch.length; j++) {
        const tagsRaw = batch[j][tagsIdx]?.trim();
        if (!tagsRaw) continue;
        const tagNames = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
        if (tagNames.length === 0) continue;

        const contactName = batch[j][nameIdx]?.trim();
        const contact = insertedContacts.find((c) => c.display_name === contactName);
        if (!contact) continue;

        for (const tagName of tagNames) {
          const { data: tag } = await supabase
            .from("tags")
            .upsert({ workspace_id: workspaceId, name: tagName }, { onConflict: "workspace_id,name" })
            .select("id")
            .single();
          if (tag) {
            await supabase.from("contact_tags").upsert({ contact_id: contact.id, tag_id: tag.id });
            tagCount++;
          }
        }
      }
    }
  }

  return NextResponse.json({
    created,
    skipped,
    tagCount,
    total: dataRows.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

/** Minimal CSV parser: handles quoted fields and newlines within quotes. */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        current.push(field);
        field = "";
      } else if (char === "\n" || (char === "\r" && next === "\n")) {
        current.push(field);
        field = "";
        if (current.some((f) => f.trim())) rows.push(current);
        current = [];
        if (char === "\r") i++;
      } else {
        field += char;
      }
    }
  }
  current.push(field);
  if (current.some((f) => f.trim())) rows.push(current);
  return rows;
}

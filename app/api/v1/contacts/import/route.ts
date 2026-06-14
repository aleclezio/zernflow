import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";

export const maxDuration = 30;

const MAX_BYTES = 5_000_000; // 5 MB upload cap (whole file is read into memory)
const MAX_ROWS = 10_000; // per-import row cap

/**
 * POST /api/v1/contacts/import  (multipart: field "file" = CSV)
 * Columns (case-insensitive headers): name/display_name (required), email
 * (optional), tags (optional, comma-separated). Active-workspace scoped.
 *
 * NOTE: this CREATES contacts (no dedup/upsert on email) — re-importing the same
 * file produces duplicates. Email-based idempotency is a tracked follow-up.
 */
export async function POST(request: NextRequest) {
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;
  const workspaceId = auth.workspaceId;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file)
    return NextResponse.json(
      { error: "No file provided. Send a CSV file as 'file' in multipart form data." },
      { status: 400 }
    );
  if (!file.name.endsWith(".csv"))
    return NextResponse.json({ error: "Only CSV files are supported." }, { status: 400 });
  if (file.size > MAX_BYTES)
    return NextResponse.json({ error: "File too large (max 5 MB)." }, { status: 400 });

  const rows = parseCSV(await file.text());
  if (rows.length < 2)
    return NextResponse.json(
      { error: "CSV must have a header row and at least one data row." },
      { status: 400 }
    );

  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_ROWS)
    return NextResponse.json(
      { error: `Too many rows (max ${MAX_ROWS}). Split the file and retry.` },
      { status: 400 }
    );

  const nameIdx = headers.findIndex((h) => h === "name" || h === "display_name" || h === "displayname");
  const emailIdx = headers.findIndex((h) => h === "email" || h === "email_address");
  const tagsIdx = headers.findIndex((h) => h === "tags" || h === "tag");
  if (nameIdx === -1)
    return NextResponse.json(
      { error: "CSV must have a 'name' or 'display_name' column." },
      { status: 400 }
    );

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];
  // Built as we insert; correlates each new contact id to its CSV row's tags by
  // INSERT ORDER (not display_name — names aren't unique, so a name-based lookup
  // would misattribute tags across duplicate-named rows).
  const contactTags: Array<{ contactId: string; tags: string[] }> = [];

  for (let i = 0; i < dataRows.length; i += 50) {
    const batch = dataRows.slice(i, i + 50);
    const inserts: Array<{ workspace_id: string; display_name: string; email: string | null; is_subscribed: boolean }> = [];
    const rowTags: string[][] = []; // rowTags[k] aligns with inserts[k]

    for (const row of batch) {
      const name = row[nameIdx]?.trim();
      if (!name) {
        skipped++;
        continue;
      }
      inserts.push({
        workspace_id: workspaceId,
        display_name: name,
        email: emailIdx !== -1 ? row[emailIdx]?.trim() || null : null,
        is_subscribed: true,
      });
      rowTags.push(
        tagsIdx !== -1
          ? (row[tagsIdx]?.split(",").map((t) => t.trim()).filter(Boolean) ?? [])
          : []
      );
    }
    if (inserts.length === 0) continue;

    const { data: inserted, error } = await supabase.from("contacts").insert(inserts).select("id");
    if (error || !inserted) {
      errors.push(`Batch ${Math.floor(i / 50) + 1}: failed`);
      continue;
    }
    created += inserted.length;
    inserted.forEach((c, k) => {
      if (rowTags[k]?.length) contactTags.push({ contactId: c.id, tags: rowTags[k] });
    });
  }

  // Tags: upsert each unique name ONCE (not per row), then batch-link. Avoids the
  // per-tag round-trip storm and dedups via the (workspace_id,name) unique index.
  let tagCount = 0;
  const uniqueNames = [...new Set(contactTags.flatMap((c) => c.tags))];
  if (uniqueNames.length > 0) {
    const { data: tags } = await supabase
      .from("tags")
      .upsert(uniqueNames.map((name) => ({ workspace_id: workspaceId, name })), {
        onConflict: "workspace_id,name",
      })
      .select("id, name");
    const tagIdByName = new Map((tags ?? []).map((t) => [t.name, t.id]));

    const links: Array<{ contact_id: string; tag_id: string }> = [];
    for (const { contactId, tags: names } of contactTags) {
      for (const n of names) {
        const tagId = tagIdByName.get(n);
        if (tagId) links.push({ contact_id: contactId, tag_id: tagId });
      }
    }
    if (links.length > 0) {
      const { error } = await supabase.from("contact_tags").upsert(links);
      if (!error) tagCount = links.length;
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

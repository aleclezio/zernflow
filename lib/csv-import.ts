/**
 * Pure helpers for the contact CSV import UI.
 * Mirror the server caps/columns in app/api/v1/contacts/import/route.ts so the
 * client can give fast feedback and a self-serve template. Server stays the
 * source of truth (it also enforces the 10k-row cap, which needs parsing).
 */

export const MAX_CSV_BYTES = 5_000_000; // keep in sync with route.ts MAX_BYTES (5 MB)

export type ValidateResult = { ok: true } | { ok: false; error: string };

/** Mirror the import route's two file-level 400 gates (extension, then size). */
export function validateCsvFile(file: { name: string; size: number }): ValidateResult {
  // Case-sensitive .csv, matching the server's file.name.endsWith(".csv") — do
  // not accept a file the server would reject.
  if (!file.name.endsWith(".csv")) {
    return { ok: false, error: "Only CSV files are supported." };
  }
  if (file.size > MAX_CSV_BYTES) {
    return { ok: false, error: "File too large (max 5 MB)." };
  }
  return { ok: true };
}

/** A downloadable starter CSV: header + one example row (valid for import as-is). */
export function csvTemplate(): string {
  return [
    "name,email,tags",
    'Jane Doe,jane@example.com,"vip,newsletter"',
  ].join("\n");
}

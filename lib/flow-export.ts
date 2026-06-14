/**
 * Pure helpers for the flow portability UI (export / import).
 * Mirror the server contracts in:
 *   - app/api/v1/flows/[flowId]/export/route.ts (download filename)
 *   - app/api/v1/flows/import/route.ts          (accepted body shape)
 * so the client can name downloads consistently and fail fast before POSTing.
 */

export interface FlowExport {
  _format: "zernflow-v1";
  name?: string;
  description?: string | null;
  nodes: unknown;
  edges: unknown;
  viewport?: unknown;
  triggers?: unknown[];
}

export type ParseFlowResult =
  | { ok: true; data: FlowExport }
  | { ok: false; error: string };

/** Download filename matching the server's Content-Disposition so a re-import round-trips. */
export function flowExportFilename(name: string): string {
  return `${name.replace(/[^a-zA-Z0-9-_]/g, "_")}.zernflow.json`;
}

/** Fail-fast client validation mirroring the import endpoint's two 400 gates. */
export function parseFlowExport(text: string): ParseFlowResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "File is not valid JSON." };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Not a ZernFlow export file (expected zernflow-v1)." };
  }
  const obj = body as Record<string, unknown>;
  if (obj._format !== "zernflow-v1") {
    return { ok: false, error: "Not a ZernFlow export file (expected zernflow-v1)." };
  }
  if (!obj.nodes || !obj.edges) {
    return { ok: false, error: "Export is missing nodes or edges." };
  }
  return { ok: true, data: obj as unknown as FlowExport };
}

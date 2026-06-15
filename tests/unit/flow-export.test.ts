import { describe, it, expect } from "vitest";
import { flowExportFilename, parseFlowExport } from "@/lib/flow-export";

describe("flowExportFilename", () => {
  it("mirrors the server slug: keeps [a-zA-Z0-9-_], replaces the rest with _", () => {
    // server: `${name.replace(/[^a-zA-Z0-9-_]/g, "_")}.zernflow.json`
    expect(flowExportFilename("My Flow")).toBe("My_Flow.zernflow.json");
  });

  it("preserves hyphens and underscores, replaces slashes/punctuation/accents", () => {
    expect(flowExportFilename("a-b_c")).toBe("a-b_c.zernflow.json");
    // é, !, and space each map to _ → three underscores after H
    expect(flowExportFilename("Hé! flow/v2")).toBe("H___flow_v2.zernflow.json");
  });

  it("handles an all-special name without throwing", () => {
    expect(flowExportFilename("@#$")).toBe("___.zernflow.json");
  });
});

describe("parseFlowExport", () => {
  const valid = JSON.stringify({
    _format: "zernflow-v1",
    name: "Welcome",
    description: null,
    nodes: [{ id: "n1" }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    triggers: [],
  });

  it("accepts a well-formed zernflow-v1 export and returns the parsed data", () => {
    const res = parseFlowExport(valid);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data._format).toBe("zernflow-v1");
      expect(res.data.nodes).toEqual([{ id: "n1" }]);
      expect(res.data.edges).toEqual([]);
    }
  });

  it("rejects invalid JSON", () => {
    const res = parseFlowExport("{ not json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/json/i);
  });

  it("rejects a wrong/missing _format (mirrors server 400)", () => {
    const res = parseFlowExport(JSON.stringify({ _format: "other", nodes: [], edges: [] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/zernflow-v1/i);
  });

  it("rejects an export missing nodes or edges (mirrors server 400)", () => {
    const noNodes = parseFlowExport(JSON.stringify({ _format: "zernflow-v1", edges: [] }));
    expect(noNodes.ok).toBe(false);
    if (!noNodes.ok) expect(noNodes.error).toMatch(/nodes|edges/i);

    const noEdges = parseFlowExport(JSON.stringify({ _format: "zernflow-v1", nodes: [] }));
    expect(noEdges.ok).toBe(false);
  });

  it("rejects a JSON primitive / null body", () => {
    expect(parseFlowExport("null").ok).toBe(false);
    expect(parseFlowExport("42").ok).toBe(false);
    expect(parseFlowExport('"a string"').ok).toBe(false);
  });
});

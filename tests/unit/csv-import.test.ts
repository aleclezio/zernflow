import { describe, it, expect } from "vitest";
import { validateCsvFile, csvTemplate, MAX_CSV_BYTES } from "@/lib/csv-import";

describe("validateCsvFile", () => {
  it("accepts a .csv file under the size cap", () => {
    expect(validateCsvFile({ name: "contacts.csv", size: 1000 })).toEqual({ ok: true });
  });

  it("accepts a file exactly at the cap (server rejects only > cap)", () => {
    expect(validateCsvFile({ name: "contacts.csv", size: MAX_CSV_BYTES }).ok).toBe(true);
  });

  it("rejects a non-.csv extension (mirrors the server 400)", () => {
    const res = validateCsvFile({ name: "contacts.txt", size: 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/csv/i);
  });

  it("rejects an uppercase .CSV — mirrors the server's case-sensitive check (don't be more permissive than the server)", () => {
    expect(validateCsvFile({ name: "contacts.CSV", size: 1000 }).ok).toBe(false);
  });

  it("rejects a file over the 5 MB cap", () => {
    const res = validateCsvFile({ name: "contacts.csv", size: MAX_CSV_BYTES + 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/large|5/i);
  });
});

describe("csvTemplate", () => {
  it("has the header row with the server-recognized columns", () => {
    const lines = csvTemplate().trim().split("\n");
    expect(lines[0].trim()).toBe("name,email,tags");
  });

  it("includes at least one example data row (server needs header + >=1 data row)", () => {
    const lines = csvTemplate().trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("quotes the multi-value tags field so commas inside it parse correctly", () => {
    // tags are comma-separated within one field; the field must be quoted
    expect(csvTemplate()).toMatch(/"[^"]*,[^"]*"/);
  });
});

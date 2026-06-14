"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2, FileDown } from "lucide-react";
import { withBasePath } from "@/lib/client-url";
import { validateCsvFile, csvTemplate } from "@/lib/csv-import";

export function ImportContactsButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function downloadTemplate() {
    const blob = new Blob([csvTemplate()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file || pendingRef.current) return;

    const check = validateCsvFile(file);
    if (!check.ok) {
      setStatus({ kind: "error", text: check.error });
      return;
    }

    pendingRef.current = true;
    setImporting(true);
    setStatus(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(withBasePath("/api/v1/contacts/import"), {
        method: "POST",
        body: form, // let the browser set the multipart boundary
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus({ kind: "error", text: data?.error ?? "Import failed. Please try again." });
        return;
      }
      const tagPart = data.tagCount ? `, ${data.tagCount} tag links` : "";
      setStatus({
        kind: "ok",
        text: `Imported ${data.created}, skipped ${data.skipped}${tagPart}. Re-importing creates duplicate contacts (no email dedup).`,
      });
      router.refresh();
    } catch (err) {
      console.error("Failed to import contacts:", err);
      setStatus({ kind: "error", text: "Import failed. Please try again." });
    } finally {
      pendingRef.current = false;
      setImporting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {status && (
        <span
          className={
            status.kind === "ok"
              ? "max-w-xs text-xs text-muted-foreground"
              : "max-w-xs text-xs text-destructive"
          }
        >
          {status.text}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleFile}
        className="hidden"
      />
      <button
        onClick={downloadTemplate}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <FileDown className="h-4 w-4" />
        Template
      </button>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={importing}
        title="CSV columns: name (required), email, tags. No email de-duplication — re-importing creates duplicates."
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
      >
        {importing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        Import CSV
      </button>
    </div>
  );
}

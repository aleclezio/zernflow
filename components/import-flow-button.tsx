"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2 } from "lucide-react";
import { withBasePath } from "@/lib/client-url";
import { parseFlowExport } from "@/lib/flow-export";

// Client-side cap: the import endpoint reads the JSON body with no size limit,
// so reject obviously-too-large files before reading/POSTing them.
const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2 MB

export function ImportFlowButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a failed attempt
    if (!file) return;

    if (file.size > MAX_IMPORT_BYTES) {
      alert("That file is too large to import (max 2 MB).");
      return;
    }

    setImporting(true);
    try {
      const parsed = parseFlowExport(await file.text());
      if (!parsed.ok) {
        alert(parsed.error);
        return;
      }

      const res = await fetch(withBasePath("/api/v1/flows/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? "Failed to import flow. Please try again.");
        return;
      }

      const flow = await res.json();
      router.push(`/dashboard/flows/${flow.id}`);
    } catch (err) {
      console.error("Failed to import flow:", err);
      alert("Failed to import flow. Please try again.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".json,.zernflow.json,application/json"
        onChange={handleFile}
        className="hidden"
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={importing}
        className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
      >
        {importing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        Import
      </button>
    </>
  );
}

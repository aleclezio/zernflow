"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { withBasePath } from "@/lib/client-url";

export function ExportContactButton({ contactId }: { contactId: string }) {
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch(withBasePath(`/api/v1/contacts/${contactId}/export`));
      if (!res.ok) {
        alert("Failed to export contact data. Please try again.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contact-${contactId}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export contact:", err);
      alert("Failed to export contact data. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={exporting}
      title="Download all stored data for this contact (GDPR export)"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50"
    >
      {exporting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      Export data
    </button>
  );
}

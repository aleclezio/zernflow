"use client";

import { useState, useEffect, useRef } from "react";
import { MessageSquarePlus, Loader2 } from "lucide-react";
import { withBasePath } from "@/lib/client-url";

type SavedReply = {
  id: string;
  title: string;
  content: string;
  shortcut: string | null;
};

/** Composer button: pick a canned reply and insert its text into the message input. */
export function SavedReplyPicker({ onInsert }: { onInsert: (content: string) => void }) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Lazy-load on first open.
  useEffect(() => {
    if (!open || loaded) return;
    setLoading(true);
    fetch(withBasePath("/api/v1/saved-replies"))
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => setReplies(d.data ?? []))
      .catch(() => setReplies([]))
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  }, [open, loaded]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Saved replies"
        aria-label="Saved replies"
        className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <MessageSquarePlus className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute bottom-12 left-0 z-10 w-72 rounded-lg border border-border bg-popover shadow-lg">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground">
            Saved replies
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : replies.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No saved replies yet.
              </p>
            ) : (
              replies.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    onInsert(r.content);
                    setOpen(false);
                  }}
                  className="block w-full rounded-md px-3 py-2 text-left hover:bg-accent"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{r.title}</span>
                    {r.shortcut && (
                      <span className="text-[10px] text-muted-foreground">/{r.shortcut}</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{r.content}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

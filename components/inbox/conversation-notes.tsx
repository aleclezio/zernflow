"use client";

import { useState, useEffect, useCallback } from "react";
import { StickyNote, Trash2, Loader2 } from "lucide-react";
import { withBasePath } from "@/lib/client-url";

type Note = {
  id: string;
  content: string;
  user_id: string;
  created_at: string;
};

/** Internal, agent-only notes for a conversation (right rail of the inbox). */
export function ConversationNotes({ conversationId }: { conversationId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(withBasePath(`/api/v1/conversations/${conversationId}/notes`));
      const data = res.ok ? await res.json() : { data: [] };
      setNotes(data.data ?? []);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addNote() {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      const res = await fetch(withBasePath(`/api/v1/conversations/${conversationId}/notes`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        const note = await res.json();
        setNotes((prev) => [...prev, note]);
        setDraft("");
      }
    } finally {
      setSaving(false);
    }
  }

  async function removeNote(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(
        withBasePath(`/api/v1/conversations/${conversationId}/notes/${id}`),
        { method: "DELETE" }
      );
      if (res.ok) setNotes((prev) => prev.filter((n) => n.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
        <StickyNote className="h-3 w-3" />
        Notes
      </h4>

      {loading ? (
        <div className="mt-2 flex justify-center py-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {notes.map((n) => (
            <div key={n.id} className="group rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap text-xs text-foreground">{n.content}</p>
                <button
                  onClick={() => removeNote(n.id)}
                  disabled={deletingId === n.id}
                  aria-label="Delete note"
                  className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                >
                  {deletingId === n.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </button>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {new Date(n.created_at).toLocaleString()}
              </p>
            </div>
          ))}
          {notes.length === 0 && (
            <p className="text-xs text-muted-foreground">No notes yet.</p>
          )}
        </div>
      )}

      <div className="mt-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Add an internal note…"
          className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          onClick={addNote}
          disabled={!draft.trim() || saving}
          className="mt-1 w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add note"}
        </button>
      </div>
    </div>
  );
}

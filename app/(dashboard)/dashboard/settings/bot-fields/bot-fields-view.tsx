"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Trash2, Loader2, Hash, Check, Copy } from "lucide-react";
import { withBasePath } from "@/lib/client-url";
import type { Database } from "@/lib/types/database";

type BotField = Database["public"]["Tables"]["bot_fields"]["Row"];

export function BotFieldsView({ initialFields }: { initialFields: BotField[] }) {
  const [fields, setFields] = useState<BotField[]>(initialFields);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", value: "", description: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function createField() {
    if (!form.name.trim() || !form.slug.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/v1/bot-fields"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          slug: form.slug.trim(),
          value: form.value,
          description: form.description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Could not create bot field.");
        return;
      }
      const created: BotField = await res.json();
      setFields((prev) => [...prev, created]);
      setForm({ name: "", slug: "", value: "", description: "" });
      setShowCreate(false);
    } finally {
      setCreating(false);
    }
  }

  async function saveValue(field: BotField, value: string) {
    setSavingId(field.id);
    try {
      const res = await fetch(withBasePath(`/api/v1/bot-fields/${field.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (res.ok) {
        const updated: BotField = await res.json();
        setFields((prev) => prev.map((f) => (f.id === field.id ? updated : f)));
      }
    } finally {
      setSavingId(null);
    }
  }

  async function deleteField(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(withBasePath(`/api/v1/bot-fields/${id}`), { method: "DELETE" });
      if (res.ok) setFields((prev) => prev.filter((f) => f.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  function copyToken(slug: string) {
    navigator.clipboard?.writeText(`{{bot.${slug}}}`);
    setCopied(slug);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        href="/dashboard/settings"
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Settings
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Bot Fields</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Workspace variables reusable across flows as <code>{"{{bot.slug}}"}</code>.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New field
        </button>
      </div>

      {showCreate && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Business name"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">Slug</label>
              <input
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder="business_name"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Value</label>
            <input
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              placeholder="Acme Inc."
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What this field is for"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <p className="text-[11px] text-muted-foreground/70">
            Slug must start with a letter and use only lowercase letters, numbers, and underscores.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowCreate(false);
                setError(null);
              }}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={createField}
              disabled={!form.name.trim() || !form.slug.trim() || creating}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {fields.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No bot fields yet. Create one to reuse a value across flows.
          </div>
        ) : (
          fields.map((field) => (
            <BotFieldRow
              key={field.id}
              field={field}
              saving={savingId === field.id}
              deleting={deletingId === field.id}
              copied={copied === field.slug}
              onSave={(value) => saveValue(field, value)}
              onDelete={() => deleteField(field.id)}
              onCopy={() => copyToken(field.slug)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function BotFieldRow({
  field,
  saving,
  deleting,
  copied,
  onSave,
  onDelete,
  onCopy,
}: {
  field: BotField;
  saving: boolean;
  deleting: boolean;
  copied: boolean;
  onSave: (value: string) => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const [value, setValue] = useState(field.value);
  const dirty = value !== field.value;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-foreground">{field.name}</span>
          <button
            onClick={onCopy}
            title="Copy token"
            className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Hash className="h-3 w-3" />
            bot.{field.slug}
            {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
          </button>
          {field.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{field.description}</p>
          )}
        </div>
        <button
          onClick={onDelete}
          disabled={deleting}
          aria-label="Delete bot field"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          onClick={() => onSave(value)}
          disabled={!dirty || saving}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

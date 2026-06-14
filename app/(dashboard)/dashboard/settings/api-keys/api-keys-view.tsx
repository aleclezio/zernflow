"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Trash2, RefreshCw, Loader2, Key, Check, Copy, X } from "lucide-react";
import { withBasePath } from "@/lib/client-url";
import type { Database } from "@/lib/types/database";

type ApiKey = Pick<
  Database["public"]["Tables"]["api_keys"]["Row"],
  "id" | "name" | "key_prefix" | "last_used_at" | "expires_at" | "created_at"
>;

export function ApiKeysView({ initialKeys }: { initialKeys: ApiKey[] }) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null); // the full key, shown once
  const [copied, setCopied] = useState(false);

  function stripKey(row: ApiKey & { key?: string }): ApiKey {
    const { key: _omit, ...rest } = row;
    void _omit;
    return rest;
  }

  async function createKey() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/v1/api-keys"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), expiresAt: expiresAt || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Could not create the key.");
        return;
      }
      setKeys((prev) => [stripKey(body), ...prev]);
      setRevealed(body.key);
      setCopied(false);
      setName("");
      setExpiresAt("");
      setShowCreate(false);
    } finally {
      setBusy(false);
    }
  }

  async function rotateKey(id: string) {
    if (!confirm("Rotate this key? The current secret stops working immediately.")) return;
    setActingId(id);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/v1/api-keys/${id}/rotate`), { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Could not rotate the key.");
        return;
      }
      setKeys((prev) => prev.map((k) => (k.id === id ? stripKey(body) : k)));
      setRevealed(body.key);
      setCopied(false);
    } finally {
      setActingId(null);
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Revoke this key? Any integration using it will stop working.")) return;
    setActingId(id);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/v1/api-keys/${id}`), { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Could not revoke the key.");
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } finally {
      setActingId(null);
    }
  }

  async function copyRevealed() {
    if (!revealed) return;
    await navigator.clipboard.writeText(revealed);
    setCopied(true);
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <Link
        href="/dashboard/settings"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Settings
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold">API Keys</h1>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New key
        </button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Programmatic access to the v1 API. Send the key as{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">Authorization: Bearer zf_…</code>. The full
        key is shown only once at creation.
      </p>

      {/* Reveal banner — shown once after issue/rotate */}
      {revealed && (
        <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-900">Copy your key now — it won&apos;t be shown again.</p>
              <code className="mt-1.5 block truncate rounded bg-white px-2 py-1.5 font-mono text-xs text-amber-900">
                {revealed}
              </code>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={copyRevealed}
                className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                onClick={() => setRevealed(null)}
                className="rounded-md p-1 text-amber-700 hover:bg-amber-100"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mt-5 rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1 text-xs font-medium text-muted-foreground">
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Zapier integration"
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Expires (optional)
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <button
              onClick={createKey}
              disabled={!name.trim() || busy}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {/* List */}
      <div className="mt-6 space-y-2">
        {keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No API keys yet.
          </p>
        ) : (
          keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{k.name}</p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{k.key_prefix}</p>
                <p className="mt-0.5 text-xs text-muted-foreground/80">
                  {k.last_used_at ? `Last used ${new Date(k.last_used_at).toLocaleDateString()}` : "Never used"}
                  {k.expires_at ? ` · Expires ${new Date(k.expires_at).toLocaleDateString()}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => rotateKey(k.id)}
                  disabled={actingId === k.id}
                  title="Rotate"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  {actingId === k.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Rotate
                </button>
                <button
                  onClick={() => revokeKey(k.id)}
                  disabled={actingId === k.id}
                  title="Revoke"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

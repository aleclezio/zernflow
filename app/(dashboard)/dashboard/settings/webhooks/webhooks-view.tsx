"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Loader2,
  Webhook,
  Check,
  Copy,
  X,
  Send,
  Power,
} from "lucide-react";
import { withBasePath } from "@/lib/client-url";
import type { Database } from "@/lib/types/database";

type WebhookEndpoint = Pick<
  Database["public"]["Tables"]["webhook_endpoints"]["Row"],
  "id" | "url" | "name" | "events" | "is_active" | "last_triggered_at" | "failure_count" | "created_at" | "updated_at"
>;

// UI labels for the 7 dispatchable events (server validates against the source of truth).
const EVENT_OPTIONS: { value: string; label: string }[] = [
  { value: "contact.created", label: "Contact created" },
  { value: "message.received", label: "Message received" },
  { value: "message.sent", label: "Message sent" },
  { value: "flow.started", label: "Flow started" },
  { value: "flow.completed", label: "Flow completed" },
  { value: "tag.added", label: "Tag added" },
  { value: "tag.removed", label: "Tag removed" },
];

export function WebhooksView({ initialEndpoints }: { initialEndpoints: WebhookEndpoint[] }) {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>(initialEndpoints);
  const [showCreate, setShowCreate] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null); // signing secret, shown once
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);

  function toggleEvent(value: string) {
    setEvents((prev) => (prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]));
  }

  async function createEndpoint() {
    if (!url.trim() || !name.trim() || events.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/v1/webhook-endpoints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          name: name.trim(),
          events,
          secret: secret.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Could not create the endpoint.");
        return;
      }
      setEndpoints((prev) => [body.data, ...prev]);
      setRevealed(body.secret);
      setCopied(false);
      setUrl("");
      setName("");
      setEvents([]);
      setSecret("");
      setShowCreate(false);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(ep: WebhookEndpoint) {
    setActingId(ep.id);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/v1/webhook-endpoints/${ep.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !ep.is_active }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Could not update the endpoint.");
        return;
      }
      setEndpoints((prev) => prev.map((e) => (e.id === ep.id ? body.data : e)));
    } finally {
      setActingId(null);
    }
  }

  async function testEndpoint(id: string) {
    setActingId(id);
    setError(null);
    setTestResult(null);
    try {
      const res = await fetch(withBasePath(`/api/v1/webhook-endpoints/${id}/test`), { method: "POST" });
      const body = await res.json().catch(() => ({}));
      const message = body.success
        ? `Delivered (HTTP ${body.statusCode})`
        : body.error || `Failed${body.statusCode ? ` (HTTP ${body.statusCode})` : ""}`;
      setTestResult({ id, ok: !!body.success, message });
    } finally {
      setActingId(null);
    }
  }

  async function deleteEndpoint(id: string) {
    if (!confirm("Delete this webhook endpoint? It will stop receiving events immediately.")) return;
    setActingId(id);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/v1/webhook-endpoints/${id}`), { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Could not delete the endpoint.");
        return;
      }
      setEndpoints((prev) => prev.filter((e) => e.id !== id));
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
          <Webhook className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold">Webhooks</h1>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New endpoint
        </button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Send workspace events to your own URL. Each delivery is signed with an HMAC-SHA256 digest in the{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">X-Zernflow-Signature</code> header. The signing
        secret is shown only once at creation.
      </p>

      {/* Reveal banner — signing secret, shown once after create */}
      {revealed && (
        <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-900">
                Copy your signing secret now — it won&apos;t be shown again.
              </p>
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
        <div className="mt-5 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <label className="block text-xs font-medium text-muted-foreground">
            Endpoint URL
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhooks/zernflow"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CRM sync"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <fieldset className="text-xs font-medium text-muted-foreground">
            Events
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {EVENT_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-normal text-foreground"
                >
                  <input
                    type="checkbox"
                    checked={events.includes(opt.value)}
                    onChange={() => toggleEvent(opt.value)}
                    className="h-3.5 w-3.5"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-xs font-medium text-muted-foreground">
            Signing secret (optional — auto-generated if blank)
            <input
              type="text"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Leave blank to generate one"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <button
            onClick={createEndpoint}
            disabled={!url.trim() || !name.trim() || events.length === 0 || busy}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create endpoint"}
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {/* List */}
      <div className="mt-6 space-y-2">
        {endpoints.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No webhook endpoints yet.
          </p>
        ) : (
          endpoints.map((ep) => (
            <div key={ep.id} className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{ep.name}</p>
                    {ep.is_active ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{ep.url}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {ep.events.map((e) => (
                      <span key={e} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {e}
                      </span>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground/80">
                    {ep.last_triggered_at
                      ? `Last delivered ${new Date(ep.last_triggered_at).toLocaleString()}`
                      : "Never delivered"}
                    {ep.failure_count > 0 ? ` · ${ep.failure_count} recent failure${ep.failure_count === 1 ? "" : "s"}` : ""}
                  </p>
                  {testResult?.id === ep.id && (
                    <p className={`mt-1 text-xs ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>
                      {testResult.message}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => testEndpoint(ep.id)}
                    disabled={actingId === ep.id}
                    title="Send a test event"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {actingId === ep.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    Test
                  </button>
                  <button
                    onClick={() => toggleActive(ep)}
                    disabled={actingId === ep.id}
                    title={ep.is_active ? "Disable" : "Enable"}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    <Power className="h-3.5 w-3.5" />
                    {ep.is_active ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => deleteEndpoint(ep.id)}
                    disabled={actingId === ep.id}
                    title="Delete"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

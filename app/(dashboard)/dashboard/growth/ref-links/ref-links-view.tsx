"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Plus,
  QrCode,
  Copy,
  Check,
  Download,
  Power,
  PowerOff,
  Trash2,
  X,
  Loader2,
  MousePointerClick,
} from "lucide-react";
import { withBasePath } from "@/lib/client-url";
import type { Database } from "@/lib/types/database";

type RefLink = Database["public"]["Tables"]["ref_links"]["Row"] & {
  flows: { name: string; status: string } | null;
};
type FlowOption = { id: string; name: string };
type ChannelOption = { id: string; platform: string; username: string | null };

export function RefLinksView({
  initialRefLinks,
  flows,
  channels,
}: {
  initialRefLinks: RefLink[];
  flows: FlowOption[];
  channels: ChannelOption[];
}) {
  const [refLinks, setRefLinks] = useState<RefLink[]>(initialRefLinks);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", flowId: "", channelId: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [qr, setQr] = useState<{ id: string; publicUrl: string; qrSvg: string } | null>(null);
  const [qrLoading, setQrLoading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function createRefLink() {
    if (!form.name.trim() || !form.flowId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/v1/ref-links"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          flowId: form.flowId,
          channelId: form.channelId || undefined,
        }),
      });
      if (!res.ok) {
        setError("Could not create ref link. Check the selected flow and channel.");
        return;
      }
      const created: RefLink = await res.json();
      setRefLinks((prev) => [created, ...prev]);
      setForm({ name: "", flowId: "", channelId: "" });
      setShowCreate(false);
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(link: RefLink) {
    setTogglingId(link.id);
    try {
      const res = await fetch(withBasePath(`/api/v1/ref-links/${link.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !link.is_active }),
      });
      if (res.ok) {
        const { data } = await res.json();
        setRefLinks((prev) => prev.map((l) => (l.id === link.id ? data : l)));
      }
    } finally {
      setTogglingId(null);
    }
  }

  async function deleteRefLink(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(withBasePath(`/api/v1/ref-links/${id}`), { method: "DELETE" });
      if (res.ok) {
        setRefLinks((prev) => prev.filter((l) => l.id !== id));
        if (qr?.id === id) setQr(null);
      }
    } finally {
      setDeletingId(null);
    }
  }

  async function openQr(id: string) {
    setQrLoading(id);
    setCopied(false);
    try {
      const res = await fetch(withBasePath(`/api/v1/ref-links/${id}/qr`));
      if (res.ok) {
        const data = await res.json();
        setQr({ id, publicUrl: data.publicUrl, qrSvg: data.qrSvg });
      }
    } finally {
      setQrLoading(null);
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadSvg(svg: string, id: string) {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ref-link-${id}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link
        href="/dashboard/growth"
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Growth
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Ref Links &amp; QR Codes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Shareable links and QR codes that start a flow when scanned or clicked.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New ref link
        </button>
      </div>

      {showCreate && (
        <div className="mt-4 rounded-lg border border-border bg-card p-4">
          {flows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create and publish a flow first — ref links point to a flow.
            </p>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Spring promo flyer"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted-foreground">Flow</label>
                  <select
                    value={form.flowId}
                    onChange={(e) => setForm((f) => ({ ...f, flowId: e.target.value }))}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Select a flow…</option>
                    {flows.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Channel (optional)
                  </label>
                  <select
                    value={form.channelId}
                    onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">No channel</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.platform}
                        {c.username ? ` · @${c.username}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
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
                  onClick={createRefLink}
                  disabled={!form.name.trim() || !form.flowId || creating}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                  Create
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 space-y-2">
        {refLinks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No ref links yet. Create one to get a shareable link and QR code.
          </div>
        ) : (
          refLinks.map((link) => (
            <div
              key={link.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{link.name}</span>
                  {!link.is_active && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      Inactive
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  /r/{link.slug}
                  {link.flows?.name ? ` → ${link.flows.name}` : ""}
                </p>
              </div>

              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Clicks">
                  <MousePointerClick className="h-3.5 w-3.5" />
                  {link.clicks}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openQr(link.id)}
                    disabled={qrLoading === link.id}
                    title="Show QR code"
                    aria-label="Show QR code"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {qrLoading === link.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <QrCode className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => toggleActive(link)}
                    disabled={togglingId === link.id}
                    title={link.is_active ? "Deactivate" : "Activate"}
                    aria-label={link.is_active ? "Deactivate" : "Activate"}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {togglingId === link.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : link.is_active ? (
                      <Power className="h-4 w-4" />
                    ) : (
                      <PowerOff className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => deleteRefLink(link.id)}
                    disabled={deletingId === link.id}
                    title="Delete"
                    aria-label="Delete"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                  >
                    {deletingId === link.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {qr && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setQr(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">QR code</h3>
              <button
                onClick={() => setQr(null)}
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div
              className="mt-4 flex justify-center rounded-md bg-white p-4 [&_svg]:h-48 [&_svg]:w-48"
              dangerouslySetInnerHTML={{ __html: qr.qrSvg }}
            />
            <div className="mt-4 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
              <span className="flex-1 truncate text-xs text-muted-foreground">{qr.publicUrl}</span>
              <button
                onClick={() => copyUrl(qr.publicUrl)}
                aria-label="Copy link"
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            <button
              onClick={() => downloadSvg(qr.qrSvg, qr.id)}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              Download SVG
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

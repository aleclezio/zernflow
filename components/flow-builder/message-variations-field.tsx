"use client";

import { Plus, X } from "lucide-react";

/**
 * Editor for a node's optional reply "variations" — alternative phrasings the
 * engine rotates through (a random one is sent) to avoid identical mass-replies.
 * Empty list = the node sends its single base text as before.
 */
export function MessageVariationsField({
  variations,
  onChange,
}: {
  variations: string[];
  onChange: (variations: string[]) => void;
}) {
  const update = (i: number, v: string) =>
    onChange(variations.map((x, idx) => (idx === i ? v : x)));
  const add = () => onChange([...variations, ""]);
  const remove = (i: number) => onChange(variations.filter((_, idx) => idx !== i));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-semibold text-foreground">Variations (optional)</label>
        {variations.length < 10 && (
          <button
            type="button"
            onClick={add}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        )}
      </div>
      {variations.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60">
          Add alternatives and a random one is sent each time (avoids identical repeated replies).
        </p>
      ) : (
        <div className="space-y-2">
          {variations.map((v, i) => (
            <div key={i} className="flex items-start gap-2">
              <textarea
                value={v}
                onChange={(e) => update(i, e.target.value)}
                rows={2}
                placeholder={`Variation ${i + 1}`}
                className="flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label="Remove variation"
                className="mt-1 rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

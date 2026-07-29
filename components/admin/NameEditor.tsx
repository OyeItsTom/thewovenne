"use client";

import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline text rename, matching StockEditor's click-to-edit idiom.
 * Renaming changes the display name only — the slug stays put, because it is
 * the public URL and changing it would break existing links.
 */
export default function NameEditor({
  value,
  onSave,
  className,
}: {
  value: string;
  onSave: (newValue: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={cn(
          "inline-flex items-center gap-1.5 text-ink transition-colors hover:text-terracotta",
          className
        )}
      >
        {value}
        <Pencil className="h-3.5 w-3.5 text-ink/30" />
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-44 rounded border border-ink/20 bg-cream px-2 py-1 text-sm text-ink focus:border-terracotta focus:outline-none"
        autoFocus
      />
      <button onClick={commit} aria-label="Save name" className="text-terracotta">
        <Check className="h-4 w-4" />
      </button>
      <button
        onClick={() => setEditing(false)}
        aria-label="Cancel rename"
        className="text-ink/40 hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

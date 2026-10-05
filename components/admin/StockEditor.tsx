"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Pencil, X } from "lucide-react";

/**
 * Click-to-edit stock count.
 *
 * Keyboard: Enter saves, Escape cancels, and focus goes back to the count
 * afterwards — before, the field vanished from under the focus and left a
 * keyboard user at the top of the page. Every control names the product,
 * because a table of "Save stock" buttons says nothing about which row.
 */
export default function StockEditor({
  value,
  label,
  onSave,
}: {
  value: number;
  /** The product's name, for accessible names. */
  label?: string;
  onSave: (newValue: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const of = label ? ` for ${label}` : "";

  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      openerRef.current?.focus();
    }
  }, [editing]);

  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    close();
  };

  if (!editing) {
    return (
      <button
        ref={openerRef}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        aria-label={`Stock${of}: ${value}. Edit`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink transition-colors hover:text-terracotta"
      >
        {value}
        <Pencil className="h-3.5 w-3.5 text-ink/40" />
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!saving) void handleSave();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        aria-label={`Stock${of}`}
        className="w-16 rounded border border-ink/20 bg-cream px-2 py-1 text-sm focus:border-terracotta focus:outline-none"
        autoFocus
      />
      <button
        onClick={handleSave}
        disabled={saving}
        aria-label={`Save stock${of}`}
        className="text-terracotta-deep disabled:opacity-50"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        onClick={close}
        aria-label={`Cancel stock edit${of}`}
        className="text-ink/50 hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

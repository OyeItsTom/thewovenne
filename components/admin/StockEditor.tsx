"use client";

import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";

export default function StockEditor({
  value,
  onSave,
}: {
  value: number;
  onSave: (newValue: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
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
        className="w-16 rounded border border-ink/20 bg-cream px-2 py-1 text-sm focus:border-terracotta focus:outline-none"
        autoFocus
      />
      <button
        onClick={handleSave}
        disabled={saving}
        aria-label="Save stock"
        className="text-terracotta disabled:opacity-50"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        onClick={() => setEditing(false)}
        aria-label="Cancel"
        className="text-ink/40 hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

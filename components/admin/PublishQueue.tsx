"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Rocket, Trash2, Pencil } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import {
  getPendingQueue,
  discardOne,
  publishOne,
  type QueueItem,
  type DraftKind,
} from "@/lib/drafts";

/**
 * The pre-flight review before publishing.
 *
 * Everything waiting to go live, with a field-level diff, so the Publish button
 * stops being a leap of faith — and anything that shouldn't ship can be pulled
 * out on its own rather than forcing an all-or-nothing choice.
 */

const KIND_LABEL: Record<DraftKind, string> = {
  product: "Product",
  category: "Category",
  journal: "Journal post",
  page: "Page",
  content: "Homepage content",
};

/** Which admin tab edits this kind of thing. */
const KIND_TAB: Record<DraftKind, string> = {
  product: "products",
  category: "categories",
  journal: "journal",
  page: "pages",
  content: "content",
};

/** Field names as they read in the admin, not as the database spells them. */
const FIELD_LABEL: Record<string, string> = {
  price_inr: "Price",
  stock_quantity: "Stock",
  is_active: "Active",
  is_visible: "Visible",
  image_url: "Cover image",
  category_id: "Category",
  parent_id: "Parent category",
  sort_order: "Order",
  meta_description: "Search description",
  in_footer: "Shown in footer",
  discount_type: "Discount type",
  discount_value: "Discount amount",
  discount_starts_at: "Discount starts",
  discount_ends_at: "Discount ends",
  collection: "Collection",
  published: "Published",
};

function fieldName(f: string) {
  return FIELD_LABEL[f] ?? f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Render a jsonb value compactly, without pretending a long body is short. */
function show(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return "(empty)";
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  }
  const j = JSON.stringify(v);
  return j.length > 80 ? `${j.slice(0, 80)}…` : j;
}

export default function PublishQueue({
  onChange,
  onEdit,
}: {
  /** Tell the dashboard something changed, so the publish count re-reads. */
  onChange?: () => void;
  /** Jump to the tab that edits this item. */
  onEdit?: (tab: string, item: QueueItem) => void;
}) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  const load = useCallback(async () => {
    const rows = await getPendingQueue(getBrowserSupabase());
    setItems(rows);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Content rows have no uuid — the key IS the identity — so the row key has to
  // fall back to the label.
  const rowId = (i: QueueItem) => `${i.kind}:${i.entity_id ?? i.label}`;

  async function handleDiscard(item: QueueItem) {
    setBusy(rowId(item));
    setError(null);
    const message = await discardOne(
      getBrowserSupabase(),
      item.kind,
      item.entity_id,
      item.kind === "content" ? item.label : undefined
    );
    setBusy(null);
    setConfirmDiscard(null);
    if (message) {
      setError(message);
      return;
    }
    await load();
    onChange?.();
  }

  async function handlePublish(item: QueueItem) {
    setBusy(rowId(item));
    setError(null);
    try {
      await publishOne(
        getBrowserSupabase(),
        item.kind,
        item.entity_id,
        item.kind === "content" ? item.label : undefined
      );
      await load();
      onChange?.();
    } catch (e) {
      // Reasons are written for the admin, e.g. "Publish its category first".
      setError(e instanceof Error ? e.message : "Could not publish that item.");
    } finally {
      setBusy(null);
    }
  }

  if (items === null) {
    return <p className="text-ink/60">Loading the queue…</p>;
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-ink/10 bg-linen/40 p-10 text-center">
        <p className="font-heading text-2xl text-ink">Nothing waiting</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink/60">
          Every change you&apos;ve made is already live. Edits show up here
          before they reach the site, so you can check them first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-2xl text-ink">
          {items.length} change{items.length === 1 ? "" : "s"} waiting to go live
        </h2>
        <p className="text-sm text-ink/60">
          Customers still see the old version until you publish.
        </p>
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      {items.map((item) => {
        const id = rowId(item);
        const working = busy === id;

        return (
          <section
            key={id}
            className="rounded-2xl border border-ink/10 bg-cream p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wider text-ink/50">
                  {KIND_LABEL[item.kind]}
                </p>
                <h3 className="font-heading text-xl text-ink">{item.label}</h3>
                <p className="mt-1 text-xs text-ink/50">
                  {new Date(item.changed_at).toLocaleString("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  {item.changed_by ? ` · ${item.changed_by}` : ""}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {onEdit && item.kind !== "content" && (
                  <button
                    onClick={() => onEdit(KIND_TAB[item.kind], item)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-ink/15 px-3 py-1.5 text-xs text-ink transition-colors hover:border-ink"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                )}

                {confirmDiscard === id ? (
                  <span className="flex items-center gap-2 text-xs">
                    <span className="text-terracotta-dark">Discard?</span>
                    <button
                      onClick={() => handleDiscard(item)}
                      disabled={working}
                      className="font-medium text-terracotta-dark underline"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmDiscard(null)}
                      className="text-ink/50"
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDiscard(id)}
                    disabled={working}
                    className="inline-flex items-center gap-1.5 rounded-full border border-ink/15 px-3 py-1.5 text-xs text-ink/60 transition-colors hover:border-terracotta hover:text-terracotta disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Discard
                  </button>
                )}

                <button
                  onClick={() => handlePublish(item)}
                  disabled={working}
                  className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
                >
                  {working ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Rocket className="h-3.5 w-3.5" />
                  )}
                  Publish this
                </button>
              </div>
            </div>

            <div className="mt-4 border-t border-ink/10 pt-4">
              {item.pending_delete ? (
                <p className="text-sm text-terracotta-dark">
                  Will be deleted from the site when you publish.
                </p>
              ) : item.is_new ? (
                <p className="text-sm text-ink/70">
                  New — it isn&apos;t on the site at all yet.
                </p>
              ) : item.changes.length === 0 ? (
                <p className="text-sm text-ink/60">
                  No field differences detected.
                </p>
              ) : (
                <dl className="space-y-2">
                  {item.changes.map((c) => (
                    <div
                      key={c.field}
                      className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]"
                    >
                      <dt className="text-ink/60">{fieldName(c.field)}</dt>
                      <dd className="flex flex-wrap items-baseline gap-2">
                        <span className="text-ink/50 line-through">
                          {show(c.old)}
                        </span>
                        <span aria-hidden className="text-ink/30">
                          →
                        </span>
                        <span className="font-medium text-ink">
                          {show(c.new)}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

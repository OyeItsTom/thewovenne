"use client";

import { useState } from "react";
import Image from "next/image";
import { Pencil, Trash2 } from "lucide-react";
import type { Product } from "@/lib/types";
import { cn, formatINR } from "@/lib/utils";
import { getBrowserSupabase } from "@/lib/supabase";
import { markPendingDelete, productDraftId, settleDraft, updateDraftVersion } from "@/lib/drafts";
import { setProductStock } from "@/lib/inventory";
import { adminErrorMessage, deleteConfirmText } from "@/lib/adminStatus";
import StockEditor from "./StockEditor";
import StatusBadges from "./StatusBadges";

/** A product listed before getAdminProducts carried facts: assume live. */
const LIVE_FALLBACK = { hasPublished: true, hasDraft: false, pendingDelete: false, liveVisible: true };

export default function ProductTable({
  products,
  onUpdate,
  onEdit,
  onDelete,
}: {
  products: Product[];
  onUpdate: (product: Product) => void;
  onEdit: (product: Product) => void;
  onDelete: (id: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last action really did. Rendered in a live region that is always
  // present, so a screen reader hears it.
  const [notice, setNotice] = useState<string | null>(null);

  // The active toggle is an edit like any other: it goes to the draft and stays
  // off the site until publish. Stock is not — see adjustStock below.
  const toggleVisibility = async (product: Product) => {
    setError(null);
    setNotice(null);
    const client = getBrowserSupabase();
    const show = !product.is_active;
    const facts = product.publication ?? LIVE_FALLBACK;

    const { id: versionId, error: draftError } = await productDraftId(
      client,
      product.id
    );
    if (draftError || !versionId) {
      setError(adminErrorMessage(draftError, `change ${product.name}`));
      return;
    }

    // Verified: success only if the draft row really changed.
    const result = await updateDraftVersion(client, "product_versions", versionId, { is_active: show }, {
      action: `change ${product.name}`,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }

    // Toggling a product off and back on lands exactly where it started, so
    // clear the draft rather than leaving a change queued that changes nothing.
    const settled = await settleDraft(client, "product", versionId);

    setNotice(
      settled && facts.hasPublished
        ? `${product.name} is back to its live setting — nothing is waiting to publish.`
        : !facts.hasPublished
          ? `${product.name} will be ${show ? "shown" : "hidden"} when it is first published. Customers can't see it yet.`
          : `${product.name} will be ${show ? "shown to" : "hidden from"} customers when you publish. Until then they see the current live version.`
    );
    // The page re-reads, so the status badges come from the database.
    onUpdate({ ...product, is_active: show });
  };

  // Stock is live inventory, not content (migration 0060): it changes now, not
  // at publish, and only if the shelf still holds the number this row showed.
  // If it has moved — a sale, a cancellation, another admin — nothing changes,
  // and the row is brought up to date so the next attempt starts from the truth.
  const adjustStock = async (product: Product, value: number) => {
    setError(null);
    const result = await setProductStock(
      getBrowserSupabase(),
      product.id,
      product.stock_quantity,
      value,
      { note: "Edited in the product table" }
    );
    setNotice(null);
    if (!result.ok) {
      setError(`${product.name}: ${result.message}`);
      if (result.live !== null) onUpdate({ ...product, stock_quantity: result.live });
      return;
    }
    setNotice(
      product.publication && !product.publication.hasPublished
        ? `Opening stock for ${product.name} is now ${result.quantity}. It goes on sale when the product is first published.`
        : `Stock for ${product.name} is now ${result.quantity} on the shop — stock is live straight away; publishing doesn't change it.`
    );
    onUpdate({ ...product, stock_quantity: result.quantity });
  };

  // Deletion is staged like everything else: the product stays live until the
  // next publish, so it is marked rather than removed.
  const remove = async (product: Product) => {
    setBusyId(product.id);
    setError(null);
    setNotice(null);
    const client = getBrowserSupabase();

    const { id: versionId, error: draftError } = await productDraftId(
      client,
      product.id
    );
    if (draftError || !versionId) {
      setBusyId(null);
      setConfirmId(null);
      setError(adminErrorMessage(draftError, `stage the deletion of ${product.name}`));
      return;
    }

    const markError = await markPendingDelete(client, "product_versions", versionId);
    setBusyId(null);
    setConfirmId(null);

    if (markError) {
      setError(markError);
      return;
    }
    // The row stays, marked "Deleting at next publish": removing it here made a
    // product that is still on sale look already gone.
    setNotice(
      product.publication && !product.publication.hasPublished
        ? `${product.name} will be removed when you next publish. It was never published, so customers aren't affected.`
        : `${product.name} will be deleted when you publish. It stays on the site, and on sale, until then.`
    );
    onDelete(product.id);
  };

  if (products.length === 0) {
    return (
      <p className="rounded-2xl bg-linen/60 p-8 text-center text-ink/60">
        No products yet. Add your first one above.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}
      <p role="status" className={notice ? "rounded-lg bg-linen/70 px-4 py-3 text-sm text-ink" : "sr-only"}>
        {notice}
      </p>

      <div className="overflow-x-auto rounded-2xl border border-ink/10">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-linen/60 text-xs uppercase tracking-wider text-ink/60">
            <tr>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Stock</th>
              <th className="px-4 py-3">Customers see</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/10">
            {products.map((product) => {
              const facts = product.publication ?? LIVE_FALLBACK;
              // The draft's own on/off setting, said only when it differs from
              // what customers see — that difference is what publishing changes.
              const afterPublish =
                facts.pendingDelete
                  ? null
                  : !facts.hasPublished
                    ? product.is_active
                      ? null
                      : "Will publish hidden"
                    : product.is_active !== facts.liveVisible
                      ? product.is_active
                        ? "Shown after you publish"
                        : "Hidden after you publish"
                      : null;
              return (
              <tr key={product.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="relative h-12 w-10 shrink-0 overflow-hidden rounded bg-linen">
                      {product.image_url && (
                        <Image
                          src={product.image_url}
                          alt={product.name}
                          fill
                          sizes="40px"
                          className="object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-ink">{product.name}</span>
                      <p className="text-xs text-ink/40">/{product.slug}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-ink/70">{product.category ?? "—"}</td>
                <td className="px-4 py-3 text-ink/70">
                  {formatINR(product.price_inr)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <StockEditor
                      value={product.stock_quantity}
                      label={product.name}
                      onSave={(value) => adjustStock(product, value)}
                    />
                    {product.stock_quantity === 0 ? (
                      <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink/70">
                        Sold out
                      </span>
                    ) : product.stock_quantity <= 5 ? (
                      <span className="rounded-full bg-terracotta/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-terracotta-dark">
                        Low
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadges facts={facts} noun="product" />
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                    {afterPublish && <span className="text-ink/70">{afterPublish}</span>}
                    {!facts.pendingDelete && (
                      // Names the ACTION, not a state: the state is the badge.
                      // A button reading "Hidden" next to a "Live" badge was
                      // two answers to one question.
                      <button
                        type="button"
                        onClick={() => toggleVisibility(product)}
                        aria-label={`${product.is_active ? "Hide" : "Show"} ${product.name} — takes effect when you publish`}
                        className={cn(
                          "rounded-full border border-ink/20 px-2.5 py-0.5 text-ink/70 transition-colors hover:border-ink hover:text-ink"
                        )}
                      >
                        {product.is_active ? "Hide" : "Show"}
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {confirmId === product.id ? (
                    <div
                      role="group"
                      aria-label={`Confirm deleting ${product.name}`}
                      className="ml-auto flex max-w-xs flex-wrap items-center justify-end gap-2 text-xs"
                    >
                      <span className="text-right text-terracotta-dark">
                        {deleteConfirmText("product", product.name, facts.hasPublished)}
                      </span>
                      <button
                        type="button"
                        onClick={() => remove(product)}
                        disabled={busyId === product.id}
                        className="rounded-full bg-terracotta-deep px-3 py-1 font-medium text-cream disabled:opacity-50"
                      >
                        {busyId === product.id ? "Staging…" : "Delete at publish"}
                      </button>
                      <button
                        type="button"
                        // Focus lands here, the safe choice, when the question appears.
                        autoFocus
                        onClick={() => setConfirmId(null)}
                        className="text-ink/70 hover:text-ink"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => onEdit(product)}
                        aria-label={`Edit ${product.name}`}
                        className="rounded p-1.5 text-ink/40 transition-colors hover:text-terracotta"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {!facts.pendingDelete && (
                        <button
                          onClick={() => setConfirmId(product.id)}
                          aria-label={`Delete ${product.name}`}
                          className="rounded p-1.5 text-ink/50 transition-colors hover:text-terracotta"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="max-w-prose text-xs text-ink/50">
        Everything here is a draft until you publish — except stock. Stock is
        live: a change saves straight to the shop, and only if the count shown
        is still the count on the shelf, so an order placed meanwhile is never
        overwritten. Publishing never changes stock.
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import Image from "next/image";
import { Pencil, Trash2 } from "lucide-react";
import type { Product } from "@/lib/types";
import { cn, formatINR } from "@/lib/utils";
import { getBrowserSupabase } from "@/lib/supabase";
import { markPendingDelete, productDraftId, settleDraft } from "@/lib/drafts";
import StockEditor from "./StockEditor";
import DraftBadge from "./DraftBadge";

export default function ProductTable({
  products,
  onUpdate,
  onEdit,
  onDelete,
  draftIds,
}: {
  products: Product[];
  onUpdate: (product: Product) => void;
  onEdit: (product: Product) => void;
  onDelete: (id: string) => void;
  draftIds?: Set<string>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stock and the active toggle are edits like any other: they go to the draft
  // and stay off the site until publish. Stock especially — see the note below
  // the table.
  const updateProduct = async (product: Product, patch: Partial<Product>) => {
    setError(null);
    const client = getBrowserSupabase();

    const { id: versionId, error: draftError } = await productDraftId(
      client,
      product.id
    );
    if (draftError || !versionId) {
      setError(draftError ?? "Could not start a draft for this product.");
      return;
    }

    const { error: updateError } = await client
      .from("product_versions")
      .update(patch)
      .eq("id", versionId);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    // Toggling a product off and back on lands exactly where it started, so
    // clear the draft rather than leaving a change queued that changes nothing.
    await settleDraft(client, "product", versionId);

    // The row already reflects the draft-merged view, so patch it locally
    // rather than re-reading.
    onUpdate({ ...product, ...patch });
  };

  // Deletion is staged like everything else: the product stays live until the
  // next publish, so it is marked rather than removed.
  const remove = async (product: Product) => {
    setBusyId(product.id);
    setError(null);
    const client = getBrowserSupabase();

    const { id: versionId, error: draftError } = await productDraftId(
      client,
      product.id
    );
    if (draftError || !versionId) {
      setBusyId(null);
      setConfirmId(null);
      setError(draftError ?? "Could not stage this deletion.");
      return;
    }

    const markError = await markPendingDelete(client, "product_versions", versionId);
    setBusyId(null);
    setConfirmId(null);

    if (markError) {
      setError(markError);
      return;
    }
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
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-ink/10">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-linen/60 text-xs uppercase tracking-wider text-ink/60">
            <tr>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Stock</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/10">
            {products.map((product) => (
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
                      {draftIds?.has(product.id) && (
                        <span className="ml-2 align-middle">
                          <DraftBadge />
                        </span>
                      )}
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
                      onSave={(value) =>
                        updateProduct(product, { stock_quantity: value })
                      }
                    />
                    {product.stock_quantity === 0 ? (
                      <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink/60">
                        Out
                      </span>
                    ) : product.stock_quantity <= 5 ? (
                      <span className="rounded-full bg-terracotta/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-terracotta-dark">
                        Low
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() =>
                      updateProduct(product, { is_active: !product.is_active })
                    }
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider transition-colors",
                      product.is_active
                        ? "bg-gold/15 text-ink hover:bg-gold/25"
                        : "bg-ink text-cream hover:bg-ink-light"
                    )}
                  >
                    {product.is_active ? "Active" : "Hidden"}
                  </button>
                </td>
                <td className="px-4 py-3">
                  {confirmId === product.id ? (
                    <div className="flex items-center justify-end gap-2 text-xs">
                      <span className="text-terracotta-dark">
Delete at next publish?
                      </span>
                      <button
                        onClick={() => remove(product)}
                        disabled={busyId === product.id}
                        className="rounded-full bg-terracotta px-3 py-1 font-medium text-cream disabled:opacity-50"
                      >
                        {busyId === product.id ? "Deleting…" : "Delete"}
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="text-ink/50 hover:text-ink"
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
                      <button
                        onClick={() => setConfirmId(product.id)}
                        aria-label={`Delete ${product.name}`}
                        className="rounded p-1.5 text-ink/30 transition-colors hover:text-terracotta"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="max-w-prose text-xs text-ink/50">
        Everything here is a draft until you publish — including stock. If you
        reduce stock after an offline sale, the shop keeps showing the old
        number until you publish, so publish stock changes promptly.
      </p>
    </div>
  );
}

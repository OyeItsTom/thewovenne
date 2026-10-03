"use client";

import { useEffect, useMemo, useState } from "react";
import { PlusCircle } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAdminProducts, getDraftProductIds } from "@/lib/products";
import type { Product } from "@/lib/types";
import Button from "@/components/ui/Button";
import ProductTable from "@/components/admin/ProductTable";
import ProductModal from "@/components/admin/ProductModal";
import ProductListControls from "@/components/admin/ProductListControls";
import {
  DEFAULT_VIEW,
  applyProductView,
  optionsFor,
  type ProductView,
} from "@/lib/adminProductView";
import SectionShell from "@/components/admin/SectionShell";
import { useDashboard } from "@/components/admin/DashboardChrome";

/**
 * Products & Stock.
 *
 * The product list, its four mutation handlers and the add/edit modal all
 * moved here together — they were only ever used by this one tab, and keeping
 * them on the dashboard meant every other section re-rendered whenever a price
 * changed.
 */
export default function ProductsSectionPage() {
  const { noteEdit } = useDashboard();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  // null while adding; a product while editing that product.
  const [editing, setEditing] = useState<Product | null>(null);
  // Search / filter / sort. View state only, kept in the page: it reorders and
  // narrows the rows already loaded — no request, no write (lib/adminProductView).
  const [view, setView] = useState<ProductView>(DEFAULT_VIEW);

  const options = useMemo(
    () => ({
      categories: optionsFor(products ?? [], (p) => p.category),
      fabrics: optionsFor(products ?? [], (p) => p.fabric),
      colours: optionsFor(products ?? [], (p) => p.colour),
    }),
    [products]
  );
  const shown = useMemo(
    () => (products ? applyProductView(products, view, draftIds) : []),
    [products, view, draftIds]
  );

  useEffect(() => {
    getAdminProducts(getBrowserSupabase()).then(setProducts);
    getDraftProductIds(getBrowserSupabase()).then(setDraftIds);
  }, []);

  const handleUpdate = (updated: Product) => {
    noteEdit();
    setProducts((prev) =>
      prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev
    );
  };

  const handleSaved = (saved: Product, isNew: boolean) => {
    noteEdit();
    return setProducts((prev) => {
      // A product created just now: its first version IS its creation, so that
      // date stands in until the next load reads products.created_at. An edit
      // keeps the creation date the row already had — the saved row only
      // carries the new version's.
      if (!prev) return [{ ...saved, product_created_at: saved.created_at }];
      return isNew
        ? [{ ...saved, product_created_at: saved.created_at }, ...prev]
        : prev.map((p) =>
            p.id === saved.id ? { ...saved, product_created_at: p.product_created_at } : p
          );
    });
  };

  const handleDelete = (id: string) => {
    noteEdit();
    setProducts((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
  };

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (product: Product) => {
    setEditing(product);
    setModalOpen(true);
  };

  return (
    <SectionShell
      id="products"
      action={
        <Button onClick={openAdd} size="md">
          <PlusCircle className="h-4 w-4" /> Add New Product
        </Button>
      }
    >
      {products === null ? (
        <p className="text-ink/60">Loading products…</p>
      ) : (
        <>
          <ProductListControls
            view={view}
            onChange={setView}
            categories={options.categories}
            fabrics={options.fabrics}
            colours={options.colours}
            shown={shown.length}
            total={products.length}
          />
          {shown.length === 0 && products.length > 0 ? (
            <p className="rounded-lg bg-linen/50 px-4 py-6 text-center text-sm text-ink/60">
              No products match your search or filters.
            </p>
          ) : (
            <ProductTable
              products={shown}
              onUpdate={handleUpdate}
              onEdit={openEdit}
              onDelete={handleDelete}
              draftIds={draftIds}
            />
          )}
        </>
      )}

      <ProductModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        product={editing}
        onSaved={handleSaved}
      />
    </SectionShell>
  );
}

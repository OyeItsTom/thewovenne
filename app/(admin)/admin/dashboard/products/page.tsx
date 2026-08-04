"use client";

import { useEffect, useState } from "react";
import { PlusCircle } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAdminProducts, getDraftProductIds } from "@/lib/products";
import type { Product } from "@/lib/types";
import Button from "@/components/ui/Button";
import ProductTable from "@/components/admin/ProductTable";
import ProductModal from "@/components/admin/ProductModal";
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
      if (!prev) return [saved];
      return isNew ? [saved, ...prev] : prev.map((p) => (p.id === saved.id ? saved : p));
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
        <ProductTable
          products={products}
          onUpdate={handleUpdate}
          onEdit={openEdit}
          onDelete={handleDelete}
          draftIds={draftIds}
        />
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

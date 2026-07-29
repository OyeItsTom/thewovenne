"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Boxes,
  LogOut,
  Package,
  PlusCircle,
  ShoppingBag,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isCurrentUserAdmin } from "@/lib/auth";
import { getAdminProducts } from "@/lib/products";
import type { Product } from "@/lib/types";
import Button from "@/components/ui/Button";
import ProductTable from "@/components/admin/ProductTable";
import ProductModal from "@/components/admin/ProductModal";
import CategoryManager from "@/components/admin/CategoryManager";
import ContentEditor from "@/components/admin/ContentEditor";
import JournalManager from "@/components/admin/JournalManager";
import TestErrorButton from "@/components/admin/TestErrorButton";

type Tab = "products" | "categories" | "content" | "journal";

export default function AdminDashboardPage() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [ordersThisWeek, setOrdersThisWeek] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  // null while adding; a product while editing that product.
  const [editing, setEditing] = useState<Product | null>(null);
  const [tab, setTab] = useState<Tab>("products");

  useEffect(() => {
    let active = true;

    // A session alone is not enough — customers authenticate against the same
    // Supabase project. Admin access is decided by profiles.is_admin.
    const verify = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;

      if (!data.session) {
        router.replace("/admin/login");
        return;
      }

      const admin = await isCurrentUserAdmin();
      if (!active) return;

      if (!admin) {
        // Signed in but not an admin: end the session rather than leave them
        // staring at a dashboard that RLS will render empty anyway.
        await supabase.auth.signOut();
        router.replace("/admin/login");
        return;
      }

      setCheckingAuth(false);
    };

    verify();

    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) router.replace("/admin/login");
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [router]);

  useEffect(() => {
    if (checkingAuth) return;
    getAdminProducts().then(setProducts);

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .gte("created_at", weekAgo)
      .then(({ count }) => setOrdersThisWeek(count ?? 0));
  }, [checkingAuth]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace("/admin/login");
  };

  const handleUpdate = (updated: Product) =>
    setProducts((prev) =>
      prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev
    );

  const handleSaved = (saved: Product, isNew: boolean) =>
    setProducts((prev) => {
      if (!prev) return [saved];
      return isNew ? [saved, ...prev] : prev.map((p) => (p.id === saved.id ? saved : p));
    });

  const handleDelete = (id: string) =>
    setProducts((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (product: Product) => {
    setEditing(product);
    setModalOpen(true);
  };

  if (checkingAuth) {
    return (
      <div className="container-wovenne section-padding text-center text-ink/60">
        Checking your session…
      </div>
    );
  }

  const total = products?.length ?? 0;
  const inStock = products?.filter((p) => p.stock_quantity > 0).length ?? 0;
  const lowStock =
    products?.filter((p) => p.stock_quantity > 0 && p.stock_quantity <= 5)
      .length ?? 0;

  return (
    <div className="container-wovenne section-padding">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-4xl text-ink sm:text-5xl">Dashboard</h1>
        <div className="flex flex-wrap gap-3">
          {tab === "products" && (
            <Button onClick={openAdd} size="md">
              <PlusCircle className="h-4 w-4" /> Add New Product
            </Button>
          )}
          <Button onClick={handleSignOut} variant="outline" size="md">
            <LogOut className="h-4 w-4" /> Sign Out
          </Button>
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Package} label="Total Products" value={total} />
        <StatCard icon={Boxes} label="Total In-Stock" value={inStock} />
        <StatCard icon={AlertTriangle} label="Low Stock (≤ 5)" value={lowStock} />
        <StatCard icon={ShoppingBag} label="Orders This Week" value={ordersThisWeek} />
      </div>

      {/* Tabs */}
      <div className="mt-10 flex gap-2 border-b border-ink/10">
        {([
          ["products", "Products & Stock"],
          ["categories", "Categories"],
          ["content", "Homepage Content"],
          ["journal", "Journal"],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={
              tab === id
                ? "border-b-2 border-terracotta px-4 py-3 text-sm font-medium text-ink"
                : "px-4 py-3 text-sm text-ink/50 hover:text-ink"
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-8">
        {tab === "products" &&
          (products === null ? (
            <p className="text-ink/60">Loading products…</p>
          ) : (
            <ProductTable
              products={products}
              onUpdate={handleUpdate}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          ))}
        {tab === "categories" && <CategoryManager />}
        {tab === "content" && <ContentEditor />}
        {tab === "journal" && <JournalManager />}
      </div>

      {/* Sentry verification */}
      <div className="mt-16 flex items-center gap-3 border-t border-ink/10 pt-6">
        <span className="text-xs uppercase tracking-wider text-ink/40">
          Diagnostics
        </span>
        <TestErrorButton />
        <span className="text-xs text-ink/40">
          Fires a test error to confirm Sentry is capturing events.
        </span>
      </div>

      <ProductModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        product={editing}
        onSaved={handleSaved}
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Package;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-linen/60 p-6">
      <Icon className="h-8 w-8 text-terracotta" strokeWidth={1.5} />
      <div>
        <p className="font-heading text-2xl text-ink">{value}</p>
        <p className="text-xs uppercase tracking-wider text-ink/50">{label}</p>
      </div>
    </div>
  );
}

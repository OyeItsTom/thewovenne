"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Boxes, LogOut, Package, PlusCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Product } from "@/lib/types";
import Button from "@/components/ui/Button";
import ProductTable from "@/components/admin/ProductTable";
import AddProductModal from "@/components/admin/AddProductModal";

export default function AdminDashboardPage() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) {
        router.replace("/admin/login");
        return;
      }
      setCheckingAuth(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!session) router.replace("/admin/login");
      }
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [router]);

  useEffect(() => {
    if (checkingAuth) return;

    supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          console.error("Admin products fetch:", error.message);
          setProducts([]);
          return;
        }
        setProducts(data ?? []);
      });
  }, [checkingAuth]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace("/admin/login");
  };

  const handleUpdate = (updated: Product) => {
    setProducts((prev) =>
      prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev
    );
  };

  const handleCreate = (created: Product) => {
    setProducts((prev) => (prev ? [created, ...prev] : [created]));
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
        <h1 className="font-heading text-4xl text-ink sm:text-5xl">
          Dashboard
        </h1>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setModalOpen(true)} size="md">
            <PlusCircle className="h-4 w-4" /> Add New Product
          </Button>
          <Button onClick={handleSignOut} variant="outline" size="md">
            <LogOut className="h-4 w-4" /> Sign Out
          </Button>
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <StatCard icon={Package} label="Total Products" value={total} />
        <StatCard icon={Boxes} label="Total In-Stock" value={inStock} />
        <StatCard
          icon={AlertTriangle}
          label="Low Stock (≤ 5)"
          value={lowStock}
        />
      </div>

      <div className="mt-10">
        {products === null ? (
          <p className="text-ink/60">Loading products…</p>
        ) : (
          <ProductTable products={products} onUpdate={handleUpdate} />
        )}
      </div>

      <AddProductModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreate}
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

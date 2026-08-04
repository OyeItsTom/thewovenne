"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Boxes, Package, ShoppingBag } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAdminProducts } from "@/lib/products";
import type { Product } from "@/lib/types";
import SectionGrid from "@/components/admin/SectionGrid";
import TestErrorButton from "@/components/admin/TestErrorButton";

/**
 * The dashboard landing page: how the shop is doing, then where to go.
 *
 * The tab bar this replaced put fourteen sections on one page, which meant the
 * page grew a little more unusable with every section added and the fourteenth
 * tab was already scrolling off the edge. Each section now owns a URL, so it
 * can be linked, bookmarked and opened in a second tab — none of which a tab
 * held in React state could do.
 *
 * The session check and the pending-changes bar live in the layout, so they
 * cover every section rather than only this page.
 */
export default function AdminDashboardPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [ordersThisWeek, setOrdersThisWeek] = useState(0);

  useEffect(() => {
    getAdminProducts(getBrowserSupabase()).then(setProducts);

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    getBrowserSupabase()
      .from("orders")
      .select("*", { count: "exact", head: true })
      .gte("created_at", weekAgo)
      .then(({ count }) => setOrdersThisWeek(count ?? 0));
  }, []);

  const total = products?.length ?? 0;
  // Sum of units, not a row count. Counting rows made "In Stock" equal
  // "Products" whenever nothing was out of stock — a stat that says nothing.
  const inStock = products?.reduce((sum, p) => sum + p.stock_quantity, 0) ?? 0;
  const lowStock =
    products?.filter((p) => p.stock_quantity > 0 && p.stock_quantity <= 5)
      .length ?? 0;

  return (
    <div>
      <h1 className="font-heading text-4xl text-ink sm:text-5xl">Dashboard</h1>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Package} label="Products" value={total} />
        <StatCard icon={Boxes} label="Units in Stock" value={inStock} />
        <StatCard icon={AlertTriangle} label="Low Stock (≤ 5)" value={lowStock} />
        <StatCard icon={ShoppingBag} label="Orders This Week" value={ordersThisWeek} />
      </div>

      <div className="mt-12">
        <SectionGrid />
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

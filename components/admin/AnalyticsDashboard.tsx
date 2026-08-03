"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import {
  getLowStock, getRevenue, getSignups, getSummary, getTopProducts,
  getWishlistCounts, RANGE_DAYS,
  type Bucket, type LowStockRow, type RevenuePoint, type SignupPoint,
  type Summary, type TopProduct, type WishlistRow,
} from "@/lib/analytics";
import LineChart from "./charts/LineChart";
import BarChart from "./charts/BarChart";

/**
 * How the shop is doing.
 *
 * Everything comes from the fixed aggregates in migration 0025, so this page
 * cannot read a customer row even by accident — and the AI chat that reuses
 * those same functions inherits the same limit.
 *
 * Panels with no data say so plainly rather than drawing an empty chart and
 * leaving it ambiguous whether the number is zero or the query is broken.
 */
export default function AnalyticsDashboard() {
  const [bucket, setBucket] = useState<Bucket>("day");
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [revenue, setRevenue] = useState<RevenuePoint[]>([]);
  const [top, setTop] = useState<TopProduct[]>([]);
  const [lowStock, setLowStock] = useState<LowStockRow[]>([]);
  const [wishlist, setWishlist] = useState<WishlistRow[]>([]);
  const [signups, setSignups] = useState<SignupPoint[]>([]);

  const load = useCallback(async (b: Bucket) => {
    setLoading(true);
    const c = getBrowserSupabase();
    const days = RANGE_DAYS[b];
    const [s, r, t, l, w, g] = await Promise.all([
      getSummary(c, days),
      getRevenue(c, b, days),
      getTopProducts(c, days),
      getLowStock(c, 3),
      getWishlistCounts(c),
      getSignups(c, 30),
    ]);
    setSummary(s); setRevenue(r); setTop(t);
    setLowStock(l); setWishlist(w); setSignups(g);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(bucket);
  }, [bucket, load]);

  const shortDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", {
      day: bucket === "month" ? undefined : "numeric",
      month: "short",
      year: bucket === "month" ? "2-digit" : undefined,
    });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-2xl text-ink">How the shop is doing</h2>
        <div className="flex rounded-full border border-ink/15 p-0.5">
          {(["day", "week", "month"] as Bucket[]).map((b) => (
            <button
              key={b}
              onClick={() => setBucket(b)}
              className={
                bucket === b
                  ? "rounded-full bg-ink px-4 py-1.5 text-xs uppercase tracking-wider text-cream"
                  : "rounded-full px-4 py-1.5 text-xs uppercase tracking-wider text-ink/60 hover:text-ink"
              }
            >
              {b === "day" ? "Daily" : b === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-sm text-ink/50">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the numbers…
        </p>
      )}

      {summary && (
        <>
          {summary.needs_review > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {summary.needs_review} order{summary.needs_review === 1 ? "" : "s"}{" "}
              need attention — see the Orders tab.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Goods, not total: postage is not revenue, and including it
                inflates the number most likely to be acted on. */}
            <Stat label="Revenue (goods)" value={formatINR(summary.goods)} />
            <Stat label="Orders" value={String(summary.orders)} />
            <Stat label="Average order" value={formatINR(summary.aov)} />
            <Stat
              label="Awaiting dispatch"
              value={String(summary.awaiting_dispatch)}
              muted={summary.awaiting_dispatch === 0}
            />
          </div>
          <p className="-mt-4 text-xs text-ink/50">
            Paid orders in the last {summary.days} days. Shipping collected:{" "}
            {formatINR(summary.shipping)}, counted separately.
          </p>
        </>
      )}

      <Panel title="Revenue over time">
        <LineChart
          points={revenue.map((p) => ({ label: shortDate(p.bucket), value: Number(p.goods) }))}
          format={(n) => (n >= 1000 ? `₹${Math.round(n / 1000)}k` : `₹${Math.round(n)}`)}
          emptyMessage="No paid orders in this period."
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Best sellers" hint="By revenue, from what was actually paid.">
          <BarChart
            bars={top.map((p) => ({
              label: p.name,
              value: Number(p.revenue),
              detail: `${p.units} unit${p.units === 1 ? "" : "s"}`,
            }))}
            format={formatINR}
            emptyMessage="Nothing sold yet."
          />
        </Panel>

        <Panel title="Running low" hint="Three or fewer left.">
          {lowStock.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink/50">
              Nothing is running low.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {lowStock.map((row, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-ink">
                    {row.name}
                    {row.size && <span className="text-ink/50"> · {row.size}</span>}
                  </span>
                  <span
                    className={
                      row.stock === 0
                        ? "shrink-0 text-terracotta-dark"
                        : "shrink-0 text-ink/70"
                    }
                  >
                    {row.stock === 0 ? "sold out" : `${row.stock} left`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Most saved" hint="Wishlist adds per product.">
          <BarChart
            bars={wishlist.map((w) => ({ label: w.name, value: w.saves }))}
            format={(n) => `${n} save${n === 1 ? "" : "s"}`}
            emptyMessage="No wishlist saves yet."
          />
        </Panel>

        <Panel title="New accounts" hint="Customers only, last 30 days.">
          <LineChart
            points={signups.map((p) => ({
              label: new Date(p.bucket).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
              }),
              value: p.signups,
            }))}
            format={(n) => String(Math.round(n))}
            colour="#C9A84C"
            emptyMessage="No signups yet."
          />
        </Panel>
      </div>

      {/* Said plainly rather than left for someone to wonder why a panel is
          missing. */}
      <p className="rounded-lg bg-linen/60 px-4 py-3 text-xs leading-relaxed text-ink/60">
        Product views aren&apos;t tracked, so &ldquo;most viewed&rdquo; isn&apos;t
        shown — it would need view logging added first. Concierge usage is counted
        but its questions are never stored, so there is nothing to report beyond
        volume.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-xl border border-ink/10 bg-cream p-5">
      <p className="text-xs uppercase tracking-wider text-ink/50">{label}</p>
      <p
        className={
          muted
            ? "mt-2 font-heading text-3xl text-ink/40"
            : "mt-2 font-heading text-3xl text-ink"
        }
      >
        {value}
      </p>
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h3 className="font-heading text-xl text-ink">{title}</h3>
      {hint && <p className="mt-1 text-xs text-ink/50">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

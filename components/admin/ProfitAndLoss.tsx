"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import { categoryLabel, financialYear, type ExpenseCategory } from "@/lib/expenses";

/**
 * Revenue → cost of goods → gross → operating costs → net.
 *
 * Every figure comes from profit_and_loss() in the database, not from adding
 * things up here, so this screen and the Excel export cannot disagree about
 * the same period.
 *
 * THE GAPS PANEL IS NOT DECORATION. Missing costs never reduce profit, so each
 * one makes the shop look better than it is. A report that flatters you
 * quietly is worse than no report, so anything unknown is stated at the top in
 * the same weight as the numbers.
 */

interface PL {
  from: string;
  to: string;
  revenue: { goods: number; delivery: number; total: number; orders: number };
  discounts_given: { coupons: number; loyalty: number; total: number };
  cogs: number;
  gross_profit: number;
  gross_margin_pct: number | null;
  operating_costs: {
    gateway_fee: number;
    gateway_tax: number;
    courier: number;
    expenses: { category: ExpenseCategory; amount: number; tax: number; entries: number }[];
    expenses_total: number;
    total: number;
  };
  net_profit: number;
  net_margin_pct: number | null;
  gaps: {
    orders_with_uncosted_items: number;
    orders_without_gateway_fee: number;
    orders_without_courier_cost: number;
    products_without_cost: number;
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export default function ProfitAndLoss() {
  const fy = financialYear();
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(today());
  const [data, setData] = useState<PL | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: result, error: rpcError } = await getBrowserSupabase().rpc(
      "profit_and_loss",
      { p_from: from, p_to: to }
    );
    setLoading(false);
    if (rpcError) {
      setError(rpcError.message);
      setData(null);
      return;
    }
    setError(null);
    setData(result as PL);
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFinancialYear = () => {
    setFrom(fy.from);
    setTo(fy.to);
  };

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-ink/10 bg-cream p-4">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wider text-ink/50">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wider text-ink/50">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
          />
        </label>
        <button
          onClick={setFinancialYear}
          className="rounded-full border border-ink/20 px-4 py-2 text-xs uppercase tracking-widest text-ink transition-colors hover:border-ink hover:bg-ink hover:text-cream"
        >
          {fy.label} — full year
        </button>
      </div>

      {loading && !data ? (
        <p className="py-10 text-center text-sm text-ink/50">Working it out…</p>
      ) : !data ? null : (
        <>
          <GapsPanel gaps={data.gaps} />

          <div className="overflow-hidden rounded-2xl border border-ink/10">
            <table className="w-full text-sm">
              <tbody>
                <Section label="Revenue" />
                <Line label="Goods" value={data.revenue.goods} />
                <Line label="Delivery charged" value={data.revenue.delivery} />
                <Total
                  label={`Total revenue — ${data.revenue.orders} order${data.revenue.orders === 1 ? "" : "s"}`}
                  value={data.revenue.total}
                />

                <Section label="Cost of goods sold" />
                <Line label="Cost of goods" value={-data.cogs} />
                <Total
                  label="Gross profit"
                  value={data.gross_profit}
                  hint={data.gross_margin_pct !== null ? `${data.gross_margin_pct}% margin` : undefined}
                />

                <Section label="Operating costs" />
                <Line label="Payment gateway fee" value={-data.operating_costs.gateway_fee} />
                <Line label="Gateway GST" value={-data.operating_costs.gateway_tax} />
                <Line label="Courier (per order)" value={-data.operating_costs.courier} />
                {data.operating_costs.expenses.map((e) => (
                  <Line
                    key={e.category}
                    label={`${categoryLabel(e.category)} — ${e.entries} entr${e.entries === 1 ? "y" : "ies"}`}
                    value={-Number(e.amount)}
                  />
                ))}
                {data.operating_costs.expenses.length === 0 && (
                  <tr className="border-t border-ink/8">
                    <td colSpan={2} className="px-4 py-2.5 text-ink/45">
                      No expenses recorded in this range.
                    </td>
                  </tr>
                )}
                <Total label="Total operating costs" value={-data.operating_costs.total} />

                <Section label="" />
                <Total label="Net profit" value={data.net_profit} emphasis
                  hint={data.net_margin_pct !== null ? `${data.net_margin_pct}% of revenue` : undefined} />
              </tbody>
            </table>
          </div>

          {/* Reported, never subtracted — already out of what was captured.
              Said here so nobody reads it as a cost that has been missed. */}
          {data.discounts_given.total > 0 && (
            <p className="rounded-2xl border border-ink/10 bg-linen/40 px-4 py-3 text-xs leading-relaxed text-ink/65">
              <strong className="font-medium text-ink">
                {formatINR(data.discounts_given.total)}
              </strong>{" "}
              given away in this period — {formatINR(data.discounts_given.coupons)} in
              discount codes, {formatINR(data.discounts_given.loyalty)} in loyalty
              points. Already deducted from the revenue above, so it is not a
              cost on top; shown because it is worth knowing what the promotions
              cost.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function GapsPanel({ gaps }: { gaps: PL["gaps"] }) {
  const items = [
    gaps.products_without_cost > 0 &&
      `${gaps.products_without_cost} product${gaps.products_without_cost === 1 ? " has" : "s have"} no cost price`,
    gaps.orders_with_uncosted_items > 0 &&
      `${gaps.orders_with_uncosted_items} order${gaps.orders_with_uncosted_items === 1 ? "" : "s"} contain items that were never costed`,
    gaps.orders_without_courier_cost > 0 &&
      `${gaps.orders_without_courier_cost} order${gaps.orders_without_courier_cost === 1 ? " has" : "s have"} no courier cost recorded`,
    gaps.orders_without_gateway_fee > 0 &&
      `${gaps.orders_without_gateway_fee} order${gaps.orders_without_gateway_fee === 1 ? " has" : "s have"} no gateway fee recorded`,
  ].filter(Boolean) as string[];

  if (items.length === 0) return null;

  return (
    <div className="rounded-2xl border border-terracotta/30 bg-terracotta/8 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-terracotta-dark">
        <AlertTriangle className="h-4 w-4" />
        This profit is overstated
      </p>
      <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink/70">
        {items.map((i) => (
          <li key={i}>· {i}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink/55">
        A cost nobody recorded cannot be subtracted, so every one of these makes
        the figures below look better than the truth — never worse.
      </p>
    </div>
  );
}

function Section({ label }: { label: string }) {
  return (
    <tr className="bg-linen/40">
      <td colSpan={2} className="px-4 py-2 text-xs uppercase tracking-wider text-ink/50">
        {label}
      </td>
    </tr>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <tr className="border-t border-ink/8">
      <td className="px-4 py-2.5 text-ink/70">{label}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-ink/80">
        {value < 0 ? `(${formatINR(Math.abs(value))})` : formatINR(value)}
      </td>
    </tr>
  );
}

function Total({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: number;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <tr className={`border-t ${emphasis ? "border-ink/40" : "border-ink/20"}`}>
      <td className={`px-4 py-3 ${emphasis ? "font-heading text-lg text-ink" : "font-medium text-ink"}`}>
        {label}
        {hint && <span className="ml-2 text-xs font-normal text-ink/50">{hint}</span>}
      </td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          emphasis ? "font-heading text-lg" : "font-medium"
        } ${value < 0 ? "text-terracotta-dark" : "text-ink"}`}
      >
        {value < 0 ? `(${formatINR(Math.abs(value))})` : formatINR(value)}
      </td>
    </tr>
  );
}

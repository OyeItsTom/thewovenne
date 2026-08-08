"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Receipt } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import {
  EXPENSE_CATEGORIES,
  categoryLabel,
  financialYear,
  type Expense,
  type ExpenseCategory,
} from "@/lib/expenses";

/**
 * What the business spends, so profit can mean something.
 *
 * Revenue and cost of goods come from orders. Everything else — courier
 * retainers, packaging, software, rent, salaries — has to be typed in, and
 * this is where.
 *
 * Every row is audited (0040), because an expense is the easiest record in the
 * system to quietly change and the hardest to notice afterwards.
 */

type Draft = {
  category: ExpenseCategory;
  amount_inr: string;
  incurred_on: string;
  description: string;
  vendor: string;
  reference: string;
};

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY: Draft = {
  category: "misc",
  amount_inr: "",
  incurred_on: today(),
  description: "",
  vendor: "",
  reference: "",
};

export default function ExpenseManager() {
  const [rows, setRows] = useState<Expense[] | null>(null);
  const [from, setFrom] = useState(financialYear().from);
  const [to, setTo] = useState(today());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: readError } = await getBrowserSupabase()
      .from("expenses")
      .select("id, category, amount_inr, incurred_on, description, vendor, reference, tax_inr, created_at")
      .gte("incurred_on", from)
      .lte("incurred_on", to)
      .order("incurred_on", { ascending: false });

    if (readError) {
      setError(readError.message);
      setRows([]);
      return;
    }
    setError(null);
    setRows((data ?? []) as Expense[]);
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const byCategory = new Map<string, number>();
    let all = 0;
    for (const r of rows ?? []) {
      const amount = Number(r.amount_inr);
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + amount);
      all += amount;
    }
    return {
      all,
      sorted: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [rows]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;

    const amount = Number(draft.amount_inr);
    if (!Number.isFinite(amount) || amount <= 0) {
      return setError("Give the expense an amount above zero.");
    }
    if (!draft.incurred_on) return setError("Give the expense a date.");

    setSaving(true);
    const { error: writeError } = await getBrowserSupabase().from("expenses").insert({
      category: draft.category,
      amount_inr: amount,
      incurred_on: draft.incurred_on,
      description: draft.description.trim() || null,
      vendor: draft.vendor.trim() || null,
      reference: draft.reference.trim() || null,
    });
    setSaving(false);
    if (writeError) return setError(writeError.message);

    // Keep the category and date: a month of receipts is entered in a run, and
    // resetting both every time turns twenty entries into sixty extra clicks.
    setDraft({ ...EMPTY, category: draft.category, incurred_on: draft.incurred_on });
    setError(null);
    void load();
  }

  async function remove(row: Expense) {
    if (
      !window.confirm(
        `Delete this ${categoryLabel(row.category)} expense of ${formatINR(Number(row.amount_inr))}?\n\nThe deletion is recorded in the activity log.`
      )
    ) {
      return;
    }
    setBusy(row.id);
    const { data, error: writeError } = await getBrowserSupabase()
      .from("expenses")
      .delete()
      .eq("id", row.id)
      .select("id");
    setBusy(null);
    if (writeError) return setError(writeError.message);
    if (!data?.length) return setError("That expense wasn't deleted. Reload and try again.");
    void load();
  }

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
        <p className="ml-auto text-sm text-ink/60">
          <span className="block text-xs uppercase tracking-wider text-ink/45">
            Total in range
          </span>
          <span className="font-heading text-2xl text-ink">{formatINR(totals.all)}</span>
        </p>
      </div>

      {!draft && (
        <button
          onClick={() => setDraft({ ...EMPTY })}
          className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink-light"
        >
          <Plus className="h-4 w-4" /> Add expense
        </button>
      )}

      {draft && (
        <form onSubmit={create} className="space-y-4 rounded-2xl border border-ink/10 bg-cream p-6">
          <h3 className="font-heading text-xl text-ink">New expense</h3>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="font-medium text-ink/70">Category</span>
              <select
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value as ExpenseCategory })
                }
                className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Amount (₹)"
              type="number"
              step="0.01"
              min="0"
              value={draft.amount_inr}
              onChange={(v) => setDraft({ ...draft, amount_inr: v })}
            />
            <Field
              label="Date"
              type="date"
              value={draft.incurred_on}
              onChange={(v) => setDraft({ ...draft, incurred_on: v })}
            />
          </div>

          {/* The rule from 0040, where someone entering a courier bill will
              actually see it. Counting a parcel twice is invisible in the
              totals and obvious only when the P&L looks wrong. */}
          {draft.category === "shipping" && (
            <p className="rounded-lg bg-linen/70 px-3 py-2 text-xs leading-relaxed text-ink/70">
              Only for courier spend you <strong className="font-medium">cannot</strong> tie
              to one order — a retainer, a pickup charge, a bulk top-up.
              Per-parcel costs belong on the order itself, and entering them in
              both places counts shipping twice in the P&amp;L.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Description"
              placeholder="March courier retainer"
              value={draft.description}
              onChange={(v) => setDraft({ ...draft, description: v })}
            />
            <Field
              label="Vendor"
              placeholder="Shiprocket"
              value={draft.vendor}
              onChange={(v) => setDraft({ ...draft, vendor: v })}
            />
            <Field
              label="Reference"
              placeholder="Their invoice number"
              value={draft.reference}
              onChange={(v) => setDraft({ ...draft, reference: v })}
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-full bg-terracotta px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save expense
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="text-sm text-ink/50 hover:text-ink"
            >
              Done
            </button>
          </div>
        </form>
      )}

      {totals.sorted.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {totals.sorted.map(([cat, amount]) => (
            <span
              key={cat}
              className="rounded-full border border-ink/12 px-3 py-1.5 text-xs text-ink/70"
            >
              {categoryLabel(cat as ExpenseCategory)}{" "}
              <span className="font-medium text-ink">{formatINR(amount)}</span>
            </span>
          ))}
        </div>
      )}

      {rows === null ? (
        <p className="py-10 text-center text-sm text-ink/50">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink/15 py-12 text-center">
          <Receipt className="mx-auto h-6 w-6 text-ink/25" />
          <p className="mt-3 text-sm text-ink/55">
            Nothing recorded in this range.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-linen/50 text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-ink/10">
                  <td className="whitespace-nowrap px-4 py-3 text-ink/70">
                    {new Date(r.incurred_on).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-4 py-3 text-ink/70">{categoryLabel(r.category)}</td>
                  <td className="px-4 py-3 text-ink/70">{r.description ?? "—"}</td>
                  <td className="px-4 py-3 text-ink/55">{r.vendor ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-ink">
                    {formatINR(Number(r.amount_inr))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(r)}
                      disabled={busy === r.id}
                      className="text-xs uppercase tracking-wider text-terracotta-dark transition-colors hover:underline disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  step,
  min,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  step?: string;
  min?: string;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      <input
        type={type}
        step={step}
        min={min}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}

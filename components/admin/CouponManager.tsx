"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Ticket } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import type { CouponRow } from "@/lib/coupons";

/**
 * Promotional codes: create, withdraw, and see what each one has actually done.
 *
 * NOTHING HERE WRITES times_used. That column is maintained only by
 * redeem_coupon() at payment (migration 0037) — a screen that could edit it
 * would let an admin hand out uses that never happened, and would race the
 * checkout while doing it. It is displayed and never submitted.
 *
 * A code is WITHDRAWN, not deleted. Orders point at the code they used, and
 * deleting the row would leave those orders referring to a promotion nobody
 * can look up. Deletion is offered only for a code that has never been used.
 */

interface CouponWithUse extends CouponRow {
  created_at: string;
}

type Draft = {
  code: string;
  discount_type: "percent" | "flat";
  discount_value: string;
  min_order_inr: string;
  expires_at: string;
  max_uses: string;
  once_per_customer: boolean;
};

const EMPTY: Draft = {
  code: "",
  discount_type: "percent",
  discount_value: "",
  min_order_inr: "",
  expires_at: "",
  max_uses: "",
  once_per_customer: false,
};

export default function CouponManager() {
  const [coupons, setCoupons] = useState<CouponWithUse[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error: readError } = await getBrowserSupabase()
      .from("coupons")
      .select(
        "id, code, discount_type, discount_value, min_order_inr, expires_at, max_uses, times_used, once_per_customer, is_active, created_at"
      )
      .order("created_at", { ascending: false });

    if (readError) {
      setError(readError.message);
      setCoupons([]);
      return;
    }
    setError(null);
    setCoupons((data ?? []) as CouponWithUse[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;

    const code = draft.code.trim().toUpperCase();
    const value = Number(draft.discount_value);

    // Checked here so the admin gets a sentence rather than a constraint
    // violation. The database checks the same things and is the one that counts.
    if (code.length < 3) return setError("A code needs at least three characters.");
    if (!Number.isFinite(value) || value <= 0)
      return setError("Give the discount a value above zero.");
    if (draft.discount_type === "percent" && value > 100)
      return setError("A percentage over 100 isn't a discount.");

    setSaving(true);
    const { error: writeError } = await getBrowserSupabase().from("coupons").insert({
      code,
      discount_type: draft.discount_type,
      discount_value: value,
      min_order_inr: draft.min_order_inr ? Number(draft.min_order_inr) : null,
      // A date input gives midnight local; a code that says it expires on the
      // 20th should still work on the 20th, so it ends at the close of that day.
      expires_at: draft.expires_at
        ? new Date(`${draft.expires_at}T23:59:59`).toISOString()
        : null,
      max_uses: draft.max_uses ? Number(draft.max_uses) : null,
      once_per_customer: draft.once_per_customer,
    });
    setSaving(false);

    if (writeError) {
      setError(
        /duplicate key/i.test(writeError.message)
          ? `There's already a code called ${code}.`
          : writeError.message
      );
      return;
    }
    setDraft(null);
    setError(null);
    void load();
  }

  async function setActive(coupon: CouponWithUse, active: boolean) {
    setBusy(coupon.id);
    // .select() so a write RLS refused is distinguishable from one that worked.
    // An UPDATE matching nothing reports success and changes nothing, which is
    // how a screen ends up claiming a code was withdrawn while it still works
    // at checkout — the trap behind #77 and #79.
    const { data, error: writeError } = await getBrowserSupabase()
      .from("coupons")
      .update({ is_active: active })
      .eq("id", coupon.id)
      .select("id");
    setBusy(null);
    if (writeError) return setError(writeError.message);
    if (!data?.length) {
      return setError(
        `${coupon.code} wasn't changed — you may no longer have permission. Reload and try again.`
      );
    }
    void load();
  }

  async function remove(coupon: CouponWithUse) {
    if (coupon.times_used > 0) return;
    if (
      !window.confirm(
        `Delete ${coupon.code}? It has never been used, so nothing refers to it.\n\nWithdrawing it instead keeps it in this list.`
      )
    ) {
      return;
    }
    setBusy(coupon.id);
    const { data, error: writeError } = await getBrowserSupabase()
      .from("coupons")
      .delete()
      .eq("id", coupon.id)
      .select("id");
    setBusy(null);
    if (writeError) return setError(writeError.message);
    if (!data?.length) {
      return setError(`${coupon.code} wasn't deleted. Reload and try again.`);
    }
    void load();
  }

  if (coupons === null) {
    return <p className="py-10 text-center text-sm text-ink/50">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      {!draft && (
        <button
          onClick={() => setDraft({ ...EMPTY })}
          className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink-light"
        >
          <Plus className="h-4 w-4" /> New code
        </button>
      )}

      {draft && (
        <form
          onSubmit={create}
          className="space-y-4 rounded-2xl border border-ink/10 bg-cream p-6"
        >
          <h3 className="font-heading text-xl text-ink">New code</h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Code"
              hint="Stored in capitals. Customers may type it either way."
              value={draft.code}
              onChange={(v) => setDraft({ ...draft, code: v.toUpperCase() })}
              placeholder="LAUNCH10"
            />
            <label className="block text-sm">
              <span className="font-medium text-ink/70">Discount</span>
              <div className="mt-1 flex gap-2">
                <select
                  value={draft.discount_type}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      discount_type: e.target.value as "percent" | "flat",
                    })
                  }
                  className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
                >
                  <option value="percent">% off</option>
                  <option value="flat">₹ off</option>
                </select>
                <input
                  value={draft.discount_value}
                  onChange={(e) => setDraft({ ...draft, discount_value: e.target.value })}
                  inputMode="numeric"
                  placeholder={draft.discount_type === "percent" ? "10" : "500"}
                  className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
                />
              </div>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Minimum order"
              hint="Optional. Measured before the discount."
              value={draft.min_order_inr}
              onChange={(v) => setDraft({ ...draft, min_order_inr: v })}
              placeholder="3000"
            />
            <label className="block text-sm">
              <span className="font-medium text-ink/70">Expires</span>
              <input
                type="date"
                value={draft.expires_at}
                onChange={(e) => setDraft({ ...draft, expires_at: e.target.value })}
                className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
              />
              <span className="mt-1 block text-xs text-ink/50">
                Optional. Works all day on the date chosen.
              </span>
            </label>
            <Field
              label="Total uses"
              hint="Optional. Blank means unlimited."
              value={draft.max_uses}
              onChange={(v) => setDraft({ ...draft, max_uses: v })}
              placeholder="50"
            />
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.once_per_customer}
              onChange={(e) =>
                setDraft({ ...draft, once_per_customer: e.target.checked })
              }
              className="mt-0.5 h-4 w-4 accent-terracotta"
            />
            <span className="text-ink/70">
              One use per customer
              <span className="mt-0.5 block text-xs text-ink/50">
                Matched on email address. Checkout is open to guests, so this
                slows someone down rather than stopping them.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-full bg-terracotta px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Create code
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="text-sm text-ink/50 hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {coupons.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink/15 py-12 text-center">
          <Ticket className="mx-auto h-6 w-6 text-ink/25" />
          <p className="mt-3 text-sm text-ink/55">
            No codes yet. A code you create here works at checkout immediately.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-linen/50 text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Discount</th>
                <th className="px-4 py-3 font-medium">Conditions</th>
                <th className="px-4 py-3 font-medium">Used</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {coupons.map((c) => (
                <CouponRowView
                  key={c.id}
                  coupon={c}
                  busy={busy === c.id}
                  onToggle={setActive}
                  onDelete={remove}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CouponRowView({
  coupon,
  busy,
  onToggle,
  onDelete,
}: {
  coupon: CouponWithUse;
  busy: boolean;
  onToggle: (c: CouponWithUse, active: boolean) => void;
  onDelete: (c: CouponWithUse) => void;
}) {
  const expired = Boolean(coupon.expires_at && new Date(coupon.expires_at) <= new Date());
  const exhausted = coupon.max_uses !== null && coupon.times_used >= coupon.max_uses;

  // What the CUSTOMER would meet, not just the is_active flag — a code that is
  // switched on but expired is off in every way that matters, and showing it as
  // "Active" is how someone spends an afternoon wondering why it is refused.
  const state = !coupon.is_active
    ? { label: "Withdrawn", tone: "text-ink/45" }
    : expired
      ? { label: "Expired", tone: "text-ink/45" }
      : exhausted
        ? { label: "Fully claimed", tone: "text-ink/45" }
        : { label: "Active", tone: "text-terracotta-dark" };

  const conditions = [
    coupon.min_order_inr ? `Over ₹${Number(coupon.min_order_inr).toLocaleString("en-IN")}` : null,
    coupon.expires_at
      ? `Until ${new Date(coupon.expires_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
      : null,
    coupon.once_per_customer ? "One per customer" : null,
  ].filter(Boolean);

  return (
    <tr className="border-t border-ink/10">
      <td className="px-4 py-3 font-medium text-ink">{coupon.code}</td>
      <td className="px-4 py-3 text-ink/70">
        {coupon.discount_type === "percent"
          ? `${Number(coupon.discount_value)}% off`
          : `₹${Number(coupon.discount_value).toLocaleString("en-IN")} off`}
      </td>
      <td className="px-4 py-3 text-ink/55">
        {conditions.length ? conditions.join(" · ") : "No conditions"}
      </td>
      <td className="px-4 py-3 text-ink/70">
        {coupon.times_used}
        {coupon.max_uses !== null && (
          <span className="text-ink/40"> / {coupon.max_uses}</span>
        )}
      </td>
      <td className={`px-4 py-3 ${state.tone}`}>{state.label}</td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={() => onToggle(coupon, !coupon.is_active)}
            disabled={busy}
            className="text-xs uppercase tracking-wider text-ink/50 transition-colors hover:text-ink disabled:opacity-40"
          >
            {coupon.is_active ? "Withdraw" : "Reinstate"}
          </button>
          {/* Only for a code nothing points at. */}
          {coupon.times_used === 0 && (
            <button
              onClick={() => onDelete(coupon)}
              disabled={busy}
              className="text-xs uppercase tracking-wider text-terracotta-dark transition-colors hover:underline disabled:opacity-40"
            >
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
      {hint && <span className="mt-1 block text-xs text-ink/50">{hint}</span>}
    </label>
  );
}

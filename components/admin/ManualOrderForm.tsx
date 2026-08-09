"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus, Trash2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import { OFFLINE_METHODS, type PaymentMethod } from "@/lib/paymentMethods";
import {
  findShortages,
  validateCustomer,
  validateLines,
  type Availability,
  type SellableProduct,
} from "@/lib/manualOrder";

/**
 * Record a sale that happened in person.
 *
 * The price on each line is EDITABLE and starts at the catalogue price. A
 * discount agreed face to face is a real decision, and a form that could not
 * record it would mean the books disagreed with the till. Cost is not editable
 * — it comes from the catalogue server-side, so a generous discount shows as
 * thin margin rather than quietly rewriting what the piece cost.
 *
 * WHAT IS CHECKED HERE IS CHECKED AGAIN IN THE ROUTE, by the same functions in
 * `lib/manualOrder.ts`. This copy exists so the operator finds out while the
 * customer is still in front of them; the route's copy is the one that decides.
 */

interface Product {
  id: string;
  name: string;
  sku: string | null;
  price_inr: number;
}

interface Size {
  product_id: string;
  label: string;
  stock_quantity: number;
}

interface Line {
  productId: string;
  size: string;
  quantity: number;
  priceInr: string;
}

interface Result {
  invoiceNumber: string | null;
  total: number;
  emailed: boolean;
  stockShort: boolean;
}

export default function ManualOrderForm() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<Size[]>([]);
  /** Live count for products that have no sizes — the same row a sale of one decrements. */
  const [singleStock, setSingleStock] = useState<Map<string, number>>(new Map());
  const [lines, setLines] = useState<Line[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowShort, setAllowShort] = useState(false);
  const [done, setDone] = useState<Result | null>(null);

  const load = useCallback(async () => {
    const client = getBrowserSupabase();
    const [{ data: p }, { data: s }, { data: v }] = await Promise.all([
      client.from("products").select("id, name, sku, price_inr").eq("is_active", true).order("name"),
      client.from("product_sizes").select("product_id, label, stock_quantity").order("sort_order"),
      // Published versions only: an unpublished piece has no live count, and
      // reserve_stock would find nothing to take.
      client.from("product_versions").select("product_id, stock_quantity").eq("state", "published"),
    ]);
    setProducts((p ?? []) as Product[]);
    setSizes((s ?? []) as Size[]);
    setSingleStock(
      new Map(
        ((v ?? []) as { product_id: string; stock_quantity: number | null }[]).map((row) => [
          row.product_id,
          Number(row.stock_quantity ?? 0),
        ])
      )
    );
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** The catalogue as the shared rules want it: a name and the sizes it has. */
  const catalogue = useMemo<SellableProduct[]>(
    () =>
      products.map((p) => ({
        id: p.id,
        name: p.name,
        sizes: sizes.filter((s) => s.product_id === p.id).map((s) => s.label),
      })),
    [products, sizes]
  );

  const availability = useMemo<Availability[]>(() => {
    const sized = new Set(sizes.map((s) => s.product_id));
    return [
      ...sizes.map((s) => ({
        productId: s.product_id,
        size: s.label,
        available: Number(s.stock_quantity ?? 0),
      })),
      ...products
        .filter((p) => !sized.has(p.id))
        .map((p) => ({
          productId: p.id,
          size: "",
          available: singleStock.get(p.id) ?? 0,
        })),
    ];
  }, [products, sizes, singleStock]);

  const parsed = useMemo(
    () =>
      lines.map((l) => ({
        productId: l.productId,
        size: l.size,
        quantity: Number(l.quantity) || 0,
        priceInr: Number(l.priceInr),
      })),
    [lines]
  );

  const shortages = useMemo(
    () => findShortages(parsed, catalogue, availability),
    [parsed, catalogue, availability]
  );

  const addLine = () => {
    const first = products[0];
    if (!first) return;
    setLines((l) => [
      ...l,
      { productId: first.id, size: "", quantity: 1, priceInr: String(first.price_inr) },
    ]);
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines((l) => l.map((row, n) => (n === i ? { ...row, ...patch } : row)));

  // Changing the product resets the price to that product's catalogue price —
  // leaving the previous one behind would silently charge the wrong amount —
  // and clears the size, which almost certainly does not exist on the new one.
  const changeProduct = (i: number, productId: string) => {
    const p = products.find((x) => x.id === productId);
    update(i, { productId, size: "", priceInr: p ? String(p.price_inr) : "0" });
  };

  const total = lines.reduce(
    (sum, l) => sum + (Number(l.priceInr) || 0) * (Number(l.quantity) || 0),
    0
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    const lineProblem = validateLines(parsed, catalogue);
    if (lineProblem) return setError(lineProblem);
    const customerProblem = validateCustomer({ name, email, phone });
    if (customerProblem) return setError(customerProblem);
    if (shortages.length > 0 && !allowShort) {
      return setError(
        "Not enough stock for that. Fix the count, or tick the box below to record the sale anyway."
      );
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/orders/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: parsed.map((l) => ({
            productId: l.productId,
            size: l.size,
            quantity: l.quantity,
            priceInr: l.priceInr,
          })),
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          paymentMethod: method,
          note,
          allowShort,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not record that order.");
      setDone(data as Result);
      setLines([]); setName(""); setEmail(""); setPhone(""); setNote("");
      setAllowShort(false);
      void load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4 rounded-2xl border border-ink/10 bg-cream p-6">
        <p className="flex items-center gap-2 font-heading text-xl text-ink">
          <Check className="h-5 w-5 text-terracotta" /> Order recorded
        </p>
        <ul className="space-y-1.5 text-sm text-ink/70">
          <li>Invoice <strong className="font-medium text-ink">{done.invoiceNumber ?? "not assigned"}</strong></li>
          <li>Total {formatINR(Number(done.total))}</li>
          <li>{done.emailed ? "Invoice emailed to the customer." : "No invoice email sent — no address given, or the provider refused it."}</li>
          {done.stockShort && (
            <li className="text-terracotta-dark">
              Stock was not reduced — for any line, not only the short one. The
              order is flagged for review; correct the counts under Products.
            </li>
          )}
        </ul>
        <button onClick={() => setDone(null)} className="text-sm text-ink/55 hover:text-ink">
          Record another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">{error}</p>
      )}

      <div className="space-y-3 rounded-2xl border border-ink/10 bg-cream p-5">
        <h3 className="font-heading text-xl text-ink">What was sold</h3>

        {lines.map((line, i) => {
          const forProduct = sizes.filter((s) => s.product_id === line.productId);
          const listPrice = products.find((p) => p.id === line.productId)?.price_inr;
          const changed = listPrice !== undefined && Number(line.priceInr) !== listPrice;
          const left = forProduct.length
            ? forProduct.find((s) => s.label === line.size)?.stock_quantity
            : singleStock.get(line.productId) ?? 0;
          const short = left !== undefined && Number(line.quantity) > left;
          return (
            <div key={i} className="rounded-lg border border-ink/10 p-3">
              <div className="grid gap-2 sm:grid-cols-[2fr,1fr,4rem,1fr,2rem]">
                <select value={line.productId} onChange={(e) => changeProduct(i, e.target.value)}
                  className="rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm">
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {/* A sized product gets no "One Size" option. Offering it was
                    the whole bug: reserve_stock looks a size row up by label, so
                    a sized piece sold as "One Size" matched nothing and the sale
                    was recorded as if the shelf were empty. */}
                <select value={line.size} onChange={(e) => update(i, { size: e.target.value })}
                  className="rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm">
                  {forProduct.length === 0 ? (
                    <option value="">One Size</option>
                  ) : (
                    <>
                      <option value="">Choose a size…</option>
                      {forProduct.map((s) => (
                        <option key={s.label} value={s.label}>{s.label} ({s.stock_quantity})</option>
                      ))}
                    </>
                  )}
                </select>
                <input type="number" min="1" value={line.quantity}
                  onChange={(e) => update(i, { quantity: Number(e.target.value) })}
                  className="rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm" />
                <div>
                  <input type="number" min="0" step="0.01" value={line.priceInr}
                    onChange={(e) => update(i, { priceInr: e.target.value })}
                    className="w-full rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm" />
                  {/* Said out loud, because an overridden price is the one thing
                      here that will be questioned later. */}
                  {changed && (
                    <span className="mt-0.5 block text-xs text-terracotta-dark">
                      was {formatINR(listPrice!)}
                    </span>
                  )}
                </div>
                <button type="button" onClick={() => setLines((l) => l.filter((_, n) => n !== i))}
                  className="text-ink/35 hover:text-terracotta-dark" aria-label="Remove line">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {/* Per line, next to the line it is about. The summary below adds
                  up duplicates; this is the one the eye lands on first. */}
              {short && (
                <p className="mt-2 text-xs text-terracotta-dark">
                  {left === 0 ? "None left" : `Only ${left} left`} on the count —{" "}
                  {line.quantity} being sold.
                </p>
              )}
            </div>
          );
        })}

        <button type="button" onClick={addLine}
          className="inline-flex items-center gap-2 rounded-full border border-ink/20 px-4 py-2 text-sm text-ink hover:border-ink">
          <Plus className="h-4 w-4" /> Add item
        </button>

        {lines.length > 0 && (
          <p className="pt-2 text-right font-heading text-2xl text-ink">{formatINR(total)}</p>
        )}
      </div>

      <div className="grid gap-4 rounded-2xl border border-ink/10 bg-cream p-5 sm:grid-cols-2">
        <h3 className="font-heading text-xl text-ink sm:col-span-2">Customer &amp; payment</h3>
        <Field label="Name" value={name} onChange={setName} required
          placeholder="Goes on the invoice" />
        <Field label="Email" value={email} onChange={setEmail} type="email"
          placeholder="The invoice is sent here" />
        <Field label="Phone" value={phone} onChange={setPhone}
          placeholder="If they'd rather not give an email" />
        <label className="block text-sm">
          <span className="font-medium text-ink/70">Paid by</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm">
            {OFFLINE_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <Field label="Note" value={note} onChange={setNote}
          placeholder="Optional — e.g. Onam pop-up, Kochi" />
        <p className="text-xs text-ink/55 sm:col-span-2">
          A name and either an email or a phone number are required. Without one
          of the two there is no way to reach them about a return, and this is
          the only moment they are standing in front of you.
        </p>
      </div>

      {/* The override. Deliberately not a "record anyway" button on the error:
          it has to be ticked before the sale is submitted, so recording a short
          sale is a decision someone made rather than a second click. */}
      {shortages.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-terracotta/40 bg-terracotta/5 p-5">
          <p className="flex items-start gap-2 text-sm text-terracotta-dark">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              The count says there is not enough stock for this sale:
              <br />
              {shortages.map((s) => (
                <span key={`${s.productId}${s.size}`} className="mt-1 block">
                  {s.name}{s.size ? ` · ${s.size}` : ""} —{" "}
                  {s.available === 0 ? "none left" : `only ${s.available} left`},{" "}
                  {s.wanted} being sold
                </span>
              ))}
            </span>
          </p>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={allowShort}
              onChange={(e) => setAllowShort(e.target.checked)}
              className="mt-1" />
            <span>
              Record it anyway — the sale happened and the count is wrong.
              <span className="mt-0.5 block text-xs text-ink/55">
                No stock will be taken off, for any line, and the order is
                flagged for review. Correct the counts under Products afterwards;
                that edit is logged.
              </span>
            </span>
          </label>
        </div>
      )}

      <button type="submit" disabled={busy || lines.length === 0 || (shortages.length > 0 && !allowShort)}
        className="inline-flex items-center gap-2 rounded-full bg-terracotta px-6 py-3 text-sm font-medium text-cream hover:bg-terracotta-dark disabled:opacity-50">
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Record order &amp; issue invoice
      </button>
      <p className="text-xs text-ink/55">
        This records a sale that has already been paid for. Stock is reduced, an
        invoice is issued in the normal sequence, and it counts in analytics and
        the P&amp;L exactly like an online order.
      </p>
    </form>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, required }: {
  label: string; value: string; onChange: (v: string) => void; type?: string;
  placeholder?: string; required?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">
        {label}
        {required && <span className="text-terracotta-dark"> *</span>}
      </span>
      <input type={type} value={value} placeholder={placeholder} required={required}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none" />
    </label>
  );
}

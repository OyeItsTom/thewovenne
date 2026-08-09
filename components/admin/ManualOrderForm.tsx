"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import { OFFLINE_METHODS, type PaymentMethod } from "@/lib/paymentMethods";

/**
 * Record a sale that happened in person.
 *
 * The price on each line is EDITABLE and starts at the catalogue price. A
 * discount agreed face to face is a real decision, and a form that could not
 * record it would mean the books disagreed with the till. Cost is not editable
 * — it comes from the catalogue server-side, so a generous discount shows as
 * thin margin rather than quietly rewriting what the piece cost.
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
  const [lines, setLines] = useState<Line[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);

  const load = useCallback(async () => {
    const client = getBrowserSupabase();
    const [{ data: p }, { data: s }] = await Promise.all([
      client.from("products").select("id, name, sku, price_inr").eq("is_active", true).order("name"),
      client.from("product_sizes").select("product_id, label, stock_quantity").order("sort_order"),
    ]);
    setProducts((p ?? []) as Product[]);
    setSizes((s ?? []) as Size[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

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
  // leaving the previous one behind would silently charge the wrong amount.
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
    if (lines.length === 0) return setError("Add at least one item.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/orders/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: lines.map((l) => ({
            productId: l.productId,
            size: l.size,
            quantity: Number(l.quantity),
            priceInr: Number(l.priceInr),
          })),
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          paymentMethod: method,
          note,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not record that order.");
      setDone(data as Result);
      setLines([]); setName(""); setEmail(""); setPhone(""); setNote("");
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
              Stock could not be reduced — the order is flagged for review.
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
          const catalogue = products.find((p) => p.id === line.productId)?.price_inr;
          const changed = catalogue !== undefined && Number(line.priceInr) !== catalogue;
          return (
            <div key={i} className="grid gap-2 rounded-lg border border-ink/10 p-3 sm:grid-cols-[2fr,1fr,4rem,1fr,2rem]">
              <select value={line.productId} onChange={(e) => changeProduct(i, e.target.value)}
                className="rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm">
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={line.size} onChange={(e) => update(i, { size: e.target.value })}
                className="rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm">
                <option value="">One Size</option>
                {forProduct.map((s) => (
                  <option key={s.label} value={s.label}>{s.label} ({s.stock_quantity})</option>
                ))}
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
                    was {formatINR(catalogue!)}
                  </span>
                )}
              </div>
              <button type="button" onClick={() => setLines((l) => l.filter((_, n) => n !== i))}
                className="text-ink/35 hover:text-terracotta-dark" aria-label="Remove line">
                <Trash2 className="h-4 w-4" />
              </button>
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
        <Field label="Name" value={name} onChange={setName} placeholder="Optional" />
        <Field label="Email" value={email} onChange={setEmail} type="email"
          placeholder="Optional — the invoice is sent here" />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="Optional" />
        <label className="block text-sm">
          <span className="font-medium text-ink/70">Paid by</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm">
            {OFFLINE_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <Field label="Note" value={note} onChange={setNote}
          placeholder="Optional — e.g. Onam pop-up, Kochi" />
      </div>

      <button type="submit" disabled={busy || lines.length === 0}
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

function Field({ label, value, onChange, type = "text", placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      <input type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none" />
    </label>
  );
}

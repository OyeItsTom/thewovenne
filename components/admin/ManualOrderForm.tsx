"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Search, Trash2, UserRound } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { getAllCategories } from "@/lib/categories";
import { formatINR } from "@/lib/utils";
import { OFFLINE_METHODS, type PaymentMethod } from "@/lib/paymentMethods";
import { getCustomers, type CustomerRow } from "@/lib/customers";
import type { Category } from "@/lib/types";
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
 *
 * SHAPED FOR SOMEONE STANDING AT A STALL. Items are found by searching or by
 * narrowing to a category, not by reading one long list of every product; a
 * returning customer is found by name rather than retyped; and the consent
 * question is asked out loud, once, at the only moment it can be.
 */

interface Product {
  id: string;
  name: string;
  sku: string | null;
  price_inr: number;
  category_id: string | null;
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
  consentRecorded: boolean;
  consentReachable: boolean;
}

export default function ManualOrderForm() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  /** Live count for products with no sizes — the row a sale of one decrements. */
  const [singleStock, setSingleStock] = useState<Map<string, number>>(new Map());
  const [lines, setLines] = useState<Line[]>([]);

  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerCategory, setPickerCategory] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);

  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  /** Set when an existing customer was chosen, so the form can say what is known. */
  const [picked, setPicked] = useState<CustomerRow | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowShort, setAllowShort] = useState(false);
  const [done, setDone] = useState<Result | null>(null);

  const load = useCallback(async () => {
    const client = getBrowserSupabase();
    const [{ data: p }, { data: s }, { data: v }, cats] = await Promise.all([
      client
        .from("products")
        .select("id, name, sku, price_inr, category_id")
        .eq("is_active", true)
        .order("name"),
      client.from("product_sizes").select("product_id, label, stock_quantity").order("sort_order"),
      // Published versions only: an unpublished piece has no live count, and
      // reserve_stock would find nothing to take.
      client.from("product_versions").select("product_id, stock_quantity").eq("state", "published"),
      // The authenticated client, or hidden categories silently vanish — and a
      // hidden category is exactly the sort of thing sold at a stall first.
      getAllCategories(client),
    ]);
    setProducts((p ?? []) as Product[]);
    setSizes((s ?? []) as Size[]);
    setCategories(cats);
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

  /**
   * The customer list, fetched ON DEMAND rather than on mount.
   *
   * admin_customers() writes an audit row every time it is called, because
   * looking at who buys from the shop is an act worth recording (0027). Loading
   * it whenever this screen opened would fill that log with reads nobody made.
   */
  const findCustomers = useCallback(async () => {
    if (customers !== null || loadingCustomers) return;
    setLoadingCustomers(true);
    setCustomers(await getCustomers(getBrowserSupabase()));
    setLoadingCustomers(false);
  }, [customers, loadingCustomers]);

  const matchingCustomers = useMemo(() => {
    const needle = customerQuery.trim().toLowerCase();
    if (!needle || !customers) return [];
    return customers
      .filter((c) =>
        [c.email, c.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))
      )
      .slice(0, 6);
  }, [customers, customerQuery]);

  /**
   * Fill the form from an existing customer.
   *
   * The phone number comes from their most recent order rather than a profile,
   * because that is the only place the shop holds one — a delivery number
   * legitimately differs between orders, so the latest is the best guess and is
   * still editable.
   */
  async function fillFromCustomer(c: CustomerRow) {
    setPicked(c);
    setName(c.name ?? "");
    setEmail(c.email);
    setCustomerQuery("");
    // Never pre-tick. If they have already consented the box is replaced by a
    // note; if they have not, they are asked again, unticked.
    setConsent(false);

    const { data } = await getBrowserSupabase()
      .from("orders")
      .select("customer_phone")
      .ilike("customer_email", c.email)
      .not("customer_phone", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const last = (data ?? [])[0] as { customer_phone?: string } | undefined;
    if (last?.customer_phone) setPhone(last.customer_phone);
  }

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
        .map((p) => ({ productId: p.id, size: "", available: singleStock.get(p.id) ?? 0 })),
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

  /** "Women → Sarees", so a bare "Sarees" cannot be mistaken for the men's one. */
  const categoryOptions = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    return categories
      .map((c) => ({
        id: c.id,
        label: c.parent_id
          ? `${byId.get(c.parent_id)?.name ?? "—"} → ${c.name}`
          : c.name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [categories]);

  /**
   * What the picker is offering.
   *
   * Every term has to match somewhere, the same rule the storefront search uses
   * — otherwise "red saree" offers every red thing alongside every saree. A
   * category narrows first, and a parent category includes its children, because
   * "Women" at a stall means everything under it.
   */
  const pickable = useMemo(() => {
    const childrenOf = new Set(
      categories.filter((c) => c.parent_id === pickerCategory).map((c) => c.id)
    );
    const terms = pickerQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return products
      .filter((p) => {
        if (pickerCategory) {
          const inCategory =
            p.category_id === pickerCategory ||
            (p.category_id !== null && childrenOf.has(p.category_id));
          if (!inCategory) return false;
        }
        if (terms.length === 0) return true;
        const haystack = `${p.name} ${p.sku ?? ""}`.toLowerCase();
        return terms.every((t) => haystack.includes(t));
      })
      .slice(0, 8);
  }, [products, categories, pickerCategory, pickerQuery]);

  const addProduct = (p: Product) => {
    setLines((l) => [...l, { productId: p.id, size: "", quantity: 1, priceInr: String(p.price_inr) }]);
    setPickerQuery("");
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines((l) => l.map((row, n) => (n === i ? { ...row, ...patch } : row)));

  const total = lines.reduce(
    (sum, l) => sum + (Number(l.priceInr) || 0) * (Number(l.quantity) || 0),
    0
  );

  /** Consent needs an address to send to, and 0050 refuses it without one. */
  const canConsent = email.trim().length > 0;
  const alreadyConsented = Boolean(picked?.marketing_consent);

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
          marketingConsent: consent && canConsent,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not record that order.");
      setDone(data as Result);
      setLines([]); setName(""); setEmail(""); setPhone(""); setNote("");
      setAllowShort(false); setConsent(false); setPicked(null);
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
          {done.consentRecorded && (
            <li>
              {done.consentReachable
                ? "Marketing consent recorded — they have an account, so they are on the list."
                : "Marketing consent recorded against this sale. They have no account, so nothing will be sent to them yet."}
            </li>
          )}
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

        {/* The picker. One long select of every product was fine with four
            pieces and stops being fine at forty — and at a stall the operator is
            holding the item, so they know its name or its category, not its
            position in an alphabetical list. */}
        <div className="grid gap-2 sm:grid-cols-[1fr,2fr]">
          <select
            value={pickerCategory}
            onChange={(e) => setPickerCategory(e.target.value)}
            className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm"
          >
            <option value="">All categories</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
            <input
              type="search"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Search by name or SKU"
              className="w-full rounded-lg border border-ink/15 bg-white py-2 pl-9 pr-3 text-sm text-ink focus:border-terracotta focus:outline-none"
            />
          </label>
        </div>

        <ul className="space-y-1">
          {pickable.map((p) => {
            const forProduct = sizes.filter((s) => s.product_id === p.id);
            const left = forProduct.length
              ? forProduct.reduce((sum, s) => sum + s.stock_quantity, 0)
              : singleStock.get(p.id) ?? 0;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => addProduct(p)}
                  className="flex w-full items-baseline justify-between gap-3 rounded-lg border border-ink/10 px-3 py-2 text-left text-sm transition-colors hover:border-ink/40"
                >
                  <span className="text-ink">
                    {p.name}
                    {p.sku && <span className="text-ink/45"> · {p.sku}</span>}
                  </span>
                  <span className="whitespace-nowrap text-ink/60">
                    {formatINR(p.price_inr)}
                    {/* The count is on the button, because the most useful moment
                        to know a piece is sold out is before adding it. */}
                    <span className={left === 0 ? "ml-2 text-terracotta-dark" : "ml-2 text-ink/45"}>
                      {left === 0 ? "none left" : `${left} in stock`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {pickable.length === 0 && (
            <li className="px-3 py-2 text-sm text-ink/50">
              Nothing matches that.
            </li>
          )}
        </ul>

        {lines.length > 0 && <div className="border-t border-ink/10 pt-3" />}

        {lines.map((line, i) => {
          const product = products.find((p) => p.id === line.productId);
          const forProduct = sizes.filter((s) => s.product_id === line.productId);
          const listPrice = product?.price_inr;
          const changed = listPrice !== undefined && Number(line.priceInr) !== listPrice;
          const left = forProduct.length
            ? forProduct.find((s) => s.label === line.size)?.stock_quantity
            : singleStock.get(line.productId) ?? 0;
          const short = left !== undefined && Number(line.quantity) > left;
          return (
            <div key={i} className="rounded-lg border border-ink/10 p-3">
              <div className="grid gap-2 sm:grid-cols-[2fr,1fr,4rem,1fr,2rem] sm:items-start">
                <p className="text-sm text-ink">
                  {product?.name ?? "Unknown product"}
                  {product?.sku && <span className="block text-xs text-ink/45">{product.sku}</span>}
                </p>
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
                <input type="number" min="1" value={line.quantity} aria-label="Quantity"
                  onChange={(e) => update(i, { quantity: Number(e.target.value) })}
                  className="rounded-lg border border-ink/15 bg-white px-2 py-2 text-sm" />
                <div>
                  <input type="number" min="0" step="0.01" value={line.priceInr} aria-label="Unit price"
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

        {lines.length > 0 && (
          <p className="pt-2 text-right font-heading text-2xl text-ink">{formatINR(total)}</p>
        )}
      </div>

      <div className="grid gap-4 rounded-2xl border border-ink/10 bg-cream p-5 sm:grid-cols-2">
        <h3 className="font-heading text-xl text-ink sm:col-span-2">Customer &amp; payment</h3>

        {/* Returning customers, found rather than retyped. Retyping an address
            is how a receipt ends up at one letter's difference from the account
            that should be able to see it. */}
        <div className="sm:col-span-2">
          <label className="relative block">
            <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
            <input
              type="search"
              value={customerQuery}
              onFocus={() => void findCustomers()}
              onChange={(e) => { setCustomerQuery(e.target.value); void findCustomers(); }}
              placeholder="Bought before? Search by name or email"
              className="w-full rounded-lg border border-ink/15 bg-white py-2 pl-9 pr-3 text-sm text-ink focus:border-terracotta focus:outline-none"
            />
          </label>
          {loadingCustomers && (
            <p className="mt-1 text-xs text-ink/50">Looking…</p>
          )}
          {customerQuery.trim() && !loadingCustomers && (
            <ul className="mt-1 space-y-1">
              {matchingCustomers.map((c) => (
                <li key={c.email}>
                  <button
                    type="button"
                    onClick={() => void fillFromCustomer(c)}
                    className="flex w-full items-baseline justify-between gap-3 rounded-lg border border-ink/10 px-3 py-2 text-left text-sm transition-colors hover:border-ink/40"
                  >
                    <span className="min-w-0">
                      <span className="text-ink">{c.name || "No name on file"}</span>
                      <span className="block truncate text-xs text-ink/45">{c.email}</span>
                    </span>
                    <span className="whitespace-nowrap text-xs text-ink/55">
                      {c.order_count} order{c.order_count === 1 ? "" : "s"} ·{" "}
                      {formatINR(Number(c.spend))}
                      {!c.has_account && <span className="text-ink/40"> · guest</span>}
                    </span>
                  </button>
                </li>
              ))}
              {matchingCustomers.length === 0 && (
                <li className="px-3 py-2 text-xs text-ink/50">
                  Nobody matches that — fill the fields below and they will be a
                  new customer.
                </li>
              )}
            </ul>
          )}
          {picked && (
            <p className="mt-1.5 text-xs text-ink/55">
              Filled from {picked.order_count} previous order
              {picked.order_count === 1 ? "" : "s"}.{" "}
              {picked.has_account ? "Has an account." : "Has never had an account."}{" "}
              Everything below is still editable.
            </p>
          )}
        </div>

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

        {/* CONSENT, ASKED RATHER THAN ASSUMED — and never pre-ticked, exactly as
            on the signup form. It is a question for the customer, so the label is
            written as the words to say out loud. */}
        <div className="rounded-lg bg-linen/60 p-4 sm:col-span-2">
          {alreadyConsented ? (
            <p className="text-sm text-ink/70">
              <strong className="font-medium text-ink">Already opted in</strong> to
              marketing email — nothing to ask, and nothing here will change it.
              They can withdraw it themselves under Preferences.
            </p>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={consent && canConsent}
                disabled={!canConsent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-1 disabled:opacity-40"
              />
              <span className={canConsent ? "text-ink" : "text-ink/45"}>
                &ldquo;Would you like to hear about new pieces by email?&rdquo; — they said yes
                <span className="mt-0.5 block text-xs text-ink/55">
                  {canConsent ? (
                    <>
                      Recorded against this sale with the date. They will only
                      actually receive marketing email if they have an account —
                      order emails are separate and always sent.
                    </>
                  ) : (
                    <>Needs an email address before it can mean anything.</>
                  )}
                </span>
              </span>
            </label>
          )}
        </div>
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

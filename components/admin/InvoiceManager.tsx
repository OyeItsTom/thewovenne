"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileText, Loader2, Send } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";

/**
 * Every invoice ever issued.
 *
 * Reads orders that HAVE an invoice number rather than a table of its own —
 * an invoice is a view of an order, not a separate record, and duplicating it
 * would create two things that could disagree about what was charged.
 *
 * DEGRADES IF 0043 IS NOT APPLIED. Credit notes are fetched separately and a
 * missing table is caught rather than thrown: the list is useful without them,
 * and an admin opening this page before the migration has run should see their
 * invoices, not an error.
 */

interface InvoiceRow {
  id: string;
  invoice_number: string;
  invoice_issued_at: string | null;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  total_inr: number;
  status: string;
  payment_status: string;
}

interface CreditNote {
  /** Needed for the download — a credit note is fetched by id, not by number. */
  id: string;
  credit_note_number: string;
  order_id: string | null;
  amount_inr: number;
  kind: string;
  issued_at: string;
}

export default function InvoiceManager() {
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [notes, setNotes] = useState<Map<string, CreditNote[]>>(new Map());
  const [creditNotesAvailable, setCreditNotesAvailable] = useState(true);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getBrowserSupabase();
    let q = client
      .from("orders")
      .select(
        "id, invoice_number, invoice_issued_at, created_at, customer_name, customer_email, total_inr, status, payment_status"
      )
      .not("invoice_number", "is", null)
      .order("invoice_issued_at", { ascending: false });

    if (from) q = q.gte("invoice_issued_at", from);
    if (to) q = q.lte("invoice_issued_at", `${to}T23:59:59`);

    const { data, error: readError } = await q;
    if (readError) {
      setError(readError.message);
      setRows([]);
      return;
    }
    setError(null);
    setRows((data ?? []) as InvoiceRow[]);

    // Separate query, and a failure here is not fatal — see the header.
    const { data: cn, error: cnError } = await client
      .from("credit_notes")
      .select("id, credit_note_number, order_id, amount_inr, kind, issued_at");
    if (cnError) {
      setCreditNotesAvailable(false);
      return;
    }
    setCreditNotesAvailable(true);
    const grouped = new Map<string, CreditNote[]>();
    for (const n of (cn ?? []) as CreditNote[]) {
      if (!n.order_id) continue;
      if (!grouped.has(n.order_id)) grouped.set(n.order_id, []);
      grouped.get(n.order_id)!.push(n);
    }
    setNotes(grouped);
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows ?? [];
    return (rows ?? []).filter((r) =>
      [r.invoice_number, r.customer_name, r.customer_email, String(r.total_inr)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    );
  }, [rows, query]);

  async function resend(row: InvoiceRow) {
    if (!row.customer_email) return;
    if (
      !window.confirm(
        `Email invoice ${row.invoice_number} to ${row.customer_email}?`
      )
    ) {
      return;
    }
    setSending(row.id);
    setSent(null);
    try {
      const res = await fetch("/api/admin/invoice/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: row.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not send that invoice.");
      setSent(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      {!creditNotesAvailable && (
        <p className="rounded-lg bg-linen/70 px-4 py-3 text-xs leading-relaxed text-ink/70">
          Credit notes are not set up yet — run migration <code>0043</code>. The
          invoice list below is unaffected.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-ink/10 bg-cream p-4">
        <label className="flex-1 text-sm" style={{ minWidth: "14rem" }}>
          <span className="block text-xs uppercase tracking-wider text-ink/50">Search</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Invoice number, customer, email or amount"
            className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wider text-ink/50">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="mt-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none" />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wider text-ink/50">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="mt-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none" />
        </label>
      </div>

      {rows === null ? (
        <p className="py-10 text-center text-sm text-ink/50">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink/15 py-12 text-center">
          <FileText className="mx-auto h-6 w-6 text-ink/25" />
          <p className="mt-3 text-sm text-ink/55">
            {rows.length === 0
              ? "No invoices yet. One is issued automatically when an order is paid."
              : "Nothing matches that search."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-linen/50 text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="px-4 py-3 font-medium">Invoice</th>
                <th className="px-4 py-3 font-medium">Issued</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Credit notes</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const credits = notes.get(r.id) ?? [];
                return (
                  <tr key={r.id} className="border-t border-ink/10">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">
                      {r.invoice_number}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink/65">
                      {r.invoice_issued_at
                        ? new Date(r.invoice_issued_at).toLocaleDateString("en-IN", {
                            day: "numeric", month: "short", year: "numeric",
                          })
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-ink/70">
                      {r.customer_name ?? "—"}
                      <span className="block text-xs text-ink/45">{r.customer_email}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-ink">
                      {formatINR(Number(r.total_inr))}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink/65">
                      {credits.length === 0 ? (
                        <span className="text-ink/35">—</span>
                      ) : (
                        // Downloadable, like the invoice it credits. A customer
                        // asking for one is asking for a document, and the pair
                        // is only useful together.
                        credits.map((c) => (
                          <a
                            key={c.id}
                            href={`/api/credit-note/${c.id}`}
                            className="block hover:text-terracotta"
                          >
                            {c.credit_note_number} · −{formatINR(Number(c.amount_inr))}
                          </a>
                        ))
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-3">
                        <a
                          href={`/api/invoice/${r.id}`}
                          className="inline-flex items-center gap-1 text-xs uppercase tracking-wider text-ink/55 hover:text-terracotta"
                        >
                          <Download className="h-3.5 w-3.5" /> PDF
                        </a>
                        {r.customer_email && (
                          <button
                            onClick={() => resend(r)}
                            disabled={sending === r.id}
                            className="inline-flex items-center gap-1 text-xs uppercase tracking-wider text-ink/55 hover:text-terracotta disabled:opacity-40"
                          >
                            {sending === r.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            {sent === r.id ? "Sent" : "Resend"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { orderRef } from "@/lib/orders";

/**
 * Refunds (OS-3, 0080): what is owed back, what Razorpay has confirmed, and
 * what needs a person.
 *
 * THIS SCREEN NEVER MAKES A REFUND. The refund is made in Razorpay's
 * dashboard; here the admin records the refund id it showed them, and the
 * server asks Razorpay about it. "Verified refunded" on this screen only ever
 * means Razorpay said processed. Nothing here accepts a refund amount or status.
 *
 * Six labels, used everywhere (owner decision O3-5, WP-12): Refund owed,
 * Awaiting verification, Refund pending, Verified refunded, Refund failed or
 * uncertain, Closed without verified refund. A credit note or a cancellation
 * is never shown as money returned. A manual (in-person) payment is marked as
 * recorded by staff, not verified. Closing without a verified refund is shown
 * only to an enrolled owner / finance approver — and enforced by the database.
 *
 * Reads go through the admin's own session (RLS: is_admin, aal2). Writes go
 * through /api/admin/refunds.
 */

interface RefundItem {
  id: string;
  razorpay_refund_id: string;
  status: string;
  amount_paise: number | null;
  provider_status: string | null;
  mode: string | null;
  uncertain_reason: string | null;
  last_verified_at: string | null;
  last_verified_source: string | null;
}

interface LedgerRow {
  ledger_key: string;
  order_id: string | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  channel: string | null;
  obligation_ids: string[] | null;
  sources: string[] | null;
  backfilled: boolean;
  open_obligations: number;
  first_owed_at: string | null;
  captured_paise: number | null;
  owed_paise: number;
  written_off_paise: number;
  refunded_paise: number;
  pending_paise: number;
  claimed_count: number;
  uncertain_count: number;
  failed_count: number;
  outstanding_paise: number;
  over_refunded_paise: number;
  provider_modes: string[] | null;
  refunds: RefundItem[] | null;
  last_verified_at: string | null;
  open_discrepancies: number;
  funds_bases: string[] | null;
  close_kinds: string[] | null;
  open_obligation_ids: string[] | null;
}

interface Discrepancy {
  id: number;
  kind: string;
  provider_mode: string | null;
  razorpay_payment_id: string | null;
  razorpay_order_id: string | null;
  razorpay_refund_id: string | null;
  order_id: string | null;
  latest_details: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
  times_seen: number;
}

interface Run {
  id: number;
  provider_mode: string;
  window_from: string;
  window_to: string;
  status: string;
  pages: number;
  payments_seen: number;
  captured_seen: number;
  discrepancies: number;
  next_skip: number;
  started_at: string;
  finished_at: string | null;
  last_error: string | null;
}

const KIND_LABEL: Record<string, string> = {
  captured_not_recorded: "Captured by Razorpay, not recorded by Wovenne",
  captured_unknown_order: "Captured for a Razorpay order Wovenne does not know",
  amount_mismatch: "Captured amount differs from Wovenne's record",
  refund_not_in_ledger: "Razorpay refunded more than the ledger knows",
  ledger_exceeds_provider: "Ledger counts more refunded than Razorpay",
  refund_without_obligation: "Money refunded on a payment nothing was owed on",
  refund_exceeds_obligation: "Refunded more than was owed",
  refund_exceeds_capture: "Refund would exceed the payment — not counted",
  refund_contradiction: "Razorpay's answers contradict each other",
  refund_claim_mismatch: "Refund id belongs to a different payment",
  refund_not_found: "Razorpay cannot find this refund",
  webhook_payload_mismatch: "Webhook payload differs from Razorpay's API",
  refund_pending_stale: "Refund pending for more than 7 days",
  refund_claim_unverified: "Refund id still unverified after 2 days",
  provider_data_incomplete: "Razorpay returned a payment without key fields",
  duplicate_obligation: "One payment owed twice, or more than was captured",
};

const CLOSE_LABEL: Record<string, string> = {
  test_mode_payment: "Test-mode payment, confirmed by Razorpay",
  refunded_outside_razorpay: "Returned outside Razorpay (recorded with evidence)",
  no_funds_received: "Manual order: no money was received",
};

const rupees = (paise: number | null | undefined) =>
  paise == null
    ? "—"
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(paise / 100);
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

export const LABELS = {
  owed: "Refund owed",
  awaiting: "Awaiting verification",
  pending: "Refund pending",
  verified: "Verified refunded",
  uncertain: "Refund failed or uncertain",
  closed: "Closed without verified refund",
  none: "Nothing owed",
} as const;

export function stateOf(r: LedgerRow): { label: string; tone: "red" | "amber" | "green" | "grey"; why?: string } {
  if (r.uncertain_count > 0) return { label: LABELS.uncertain, tone: "red", why: "Razorpay's answers disagree — do not refund again until resolved" };
  if (r.over_refunded_paise > 0) return { label: LABELS.uncertain, tone: "red", why: "more was refunded than owed — do not refund again" };
  if (r.open_discrepancies > 0) return { label: LABELS.uncertain, tone: "red", why: "an open discrepancy needs a person" };
  if (r.failed_count > 0 && r.outstanding_paise > 0) return { label: LABELS.uncertain, tone: "red", why: "a refund failed at Razorpay; the money is still owed" };
  if (r.pending_paise > 0) return { label: LABELS.pending, tone: "amber", why: "Razorpay says pending" };
  if (r.claimed_count > 0) return { label: LABELS.awaiting, tone: "amber", why: "refund id recorded, Razorpay not yet asked or not yet answered" };
  if (r.outstanding_paise > 0) return { label: LABELS.owed, tone: "red" };
  if (r.written_off_paise > 0) return { label: LABELS.closed, tone: "grey" };
  if (r.refunded_paise > 0) return { label: LABELS.verified, tone: "green", why: "Razorpay: processed" };
  return { label: LABELS.none, tone: "grey" };
}
const isManual = (r: LedgerRow) => !!r.funds_bases?.includes("manual_recorded");
const TONE = {
  red: "bg-terracotta/10 text-terracotta",
  amber: "bg-amber-100 text-amber-900",
  green: "bg-emerald-50 text-emerald-800",
  grey: "bg-ink/5 text-ink/60",
};

export default function RefundsManager() {
  const supabase = getBrowserSupabase();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [disc, setDisc] = useState<Discrepancy[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const [canClose, setCanClose] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [l, d, r, a] = await Promise.all([
      supabase.from("refund_ledger").select("*").order("first_owed_at", { ascending: true }),
      supabase.from("payment_reconciliation_discrepancies").select("*").eq("status", "open").order("first_seen_at"),
      supabase.from("payment_reconciliation_runs").select("*").order("id", { ascending: false }).limit(5),
      supabase.rpc("refund_closure_authority"),
    ]);
    // Display only: the database refuses a closure from anyone else regardless.
    setCanClose(a.data === true);
    if (l.error || d.error || r.error) {
      setLoadError((l.error ?? d.error ?? r.error)?.message ?? "Could not load the ledger.");
    }
    setRows((l.data as LedgerRow[]) ?? []);
    setDisc((d.data as Discrepancy[]) ?? []);
    setRuns((r.data as Run[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (key: string, payload: Record<string, unknown>) => {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && json.error) {
        setMessage({ text: json.error, bad: true });
      } else if (json.verification && json.verification.ok === false) {
        setMessage({ text: json.verification.message, bad: true });
      } else if (json.verification?.ok) {
        const v = json.verification;
        setMessage({
          text: `Razorpay says: ${v.status}${v.outcome === "uncertain" ? ` — UNCERTAIN: ${v.reason}` : ""}${v.discrepancies?.length ? " (discrepancy recorded)" : ""}.`,
          bad: v.outcome === "uncertain",
        });
      } else if (json.result?.outcome === "closed") {
        setMessage({
          text: `${LABELS.closed}: ${rupees(Number(json.result.written_off_paise))} closed with your name and the evidence. This is not a refund.`,
          bad: false,
        });
      } else if (json.result?.message) {
        setMessage({ text: json.result.message, bad: !json.ok });
      } else {
        setMessage({ text: "Done.", bad: false });
      }
    } catch {
      setMessage({ text: "The request did not complete. Nothing is assumed; reload and check.", bad: true });
    } finally {
      setBusy(null);
      await load();
    }
  };

  const totals = useMemo(() => {
    const live = rows.filter((r) => !r.backfilled);
    return {
      outstanding: rows.filter((r) => !isManual(r)).reduce((s, r) => s + r.outstanding_paise, 0),
      manualOutstanding: rows.filter(isManual).reduce((s, r) => s + r.outstanding_paise, 0),
      refunded: rows.reduce((s, r) => s + r.refunded_paise, 0),
      pending: rows.reduce((s, r) => s + r.pending_paise, 0),
      attention: rows.filter((r) => stateOf(r).tone === "red").length,
      backfilled: rows.length - live.length,
    };
  }, [rows]);

  const visible = rows.filter(
    (r) => showSettled || r.outstanding_paise > 0 || r.pending_paise > 0 || r.claimed_count > 0 || r.uncertain_count > 0 || r.open_discrepancies > 0 || r.over_refunded_paise > 0
  );

  if (loading && !rows.length) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the refund ledger…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-ink/70">
        Refunds are made in <strong>Razorpay&apos;s dashboard</strong>. Then record the refund id here; Wovenne asks
        Razorpay and shows its answer. A cancellation or a credit note does not mean the money went back — only
        Razorpay saying <em>processed</em> makes it <strong>{LABELS.verified}</strong>.
      </p>

      {loadError && <p className="rounded bg-terracotta/10 p-3 text-sm text-terracotta">{loadError}</p>}
      {message && (
        <p role="status" className={`rounded p-3 text-sm ${message.bad ? "bg-terracotta/10 text-terracotta" : "bg-emerald-50 text-emerald-800"}`}>
          {message.text}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          [`${LABELS.owed} (Razorpay)`, rupees(totals.outstanding)],
          [`${LABELS.owed} (manual, unverified)`, rupees(totals.manualOutstanding)],
          [LABELS.pending, rupees(totals.pending)],
          [LABELS.verified, rupees(totals.refunded)],
          ["Need attention", String(totals.attention + disc.length)],
        ].map(([k, v]) => (
          <div key={k} className="rounded border border-ink/10 p-3">
            <div className="text-[11px] uppercase tracking-widest text-ink/50">{k}</div>
            <div className="mt-1 text-lg tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-widest text-ink/60">Refund ledger</h2>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} /> Show settled
            </label>
            <button onClick={() => void load()} className="inline-flex items-center gap-1 text-ink/60 hover:text-terracotta">
              <RefreshCw className="h-3 w-3" /> Reload
            </button>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="text-sm text-ink/60">Nothing outstanding.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-widest text-ink/50">
                <tr>
                  <th className="py-2 pr-3">Order</th>
                  <th className="py-2 pr-3">Payment</th>
                  <th className="py-2 pr-3 text-right">Captured</th>
                  <th className="py-2 pr-3 text-right">Owed</th>
                  <th className="py-2 pr-3 text-right">Verified refunded</th>
                  <th className="py-2 pr-3 text-right">Outstanding</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Last checked</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const st = stateOf(r);
                  const isOpen = open === r.ledger_key;
                  return (
                    <RowBlock
                      key={r.ledger_key}
                      r={r}
                      st={st}
                      isOpen={isOpen}
                      toggle={() => setOpen(isOpen ? null : r.ledger_key)}
                      busy={busy}
                      post={post}
                      canClose={canClose}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {totals.backfilled > 0 && (
          <p className="mt-2 text-xs text-ink/50">
            {totals.backfilled} row(s) were brought in when the ledger was created (marked “before ledger”). A payment
            taken with Razorpay Test keys was never real money: an approver closes each one with “Check Test mode with
            Razorpay”, which asks Razorpay before closing. Never in bulk.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm uppercase tracking-widest text-ink/60">Needs investigation ({disc.length})</h2>
        {disc.length === 0 ? (
          <p className="text-sm text-ink/60">No open discrepancies.</p>
        ) : (
          <ul className="space-y-2">
            {disc.map((d) => (
              <DiscrepancyItem key={d.id} d={d} busy={busy} post={post} />
            ))}
          </ul>
        )}
      </section>

      <ReconcilePanel runs={runs} busy={busy} post={post} />
    </div>
  );
}

function RowBlock({
  r,
  st,
  isOpen,
  toggle,
  busy,
  post,
  canClose,
}: {
  r: LedgerRow;
  st: ReturnType<typeof stateOf>;
  isOpen: boolean;
  toggle: () => void;
  busy: string | null;
  post: (k: string, p: Record<string, unknown>) => Promise<void>;
  canClose: boolean;
}) {
  const [refundId, setRefundId] = useState("");
  const [note, setNote] = useState("");
  const manual = isManual(r);
  const [closeKind, setCloseKind] = useState("refunded_outside_razorpay");
  const [closeReason, setCloseReason] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [amountInr, setAmountInr] = useState("");
  const [settledOn, setSettledOn] = useState("");
  const [testReason, setTestReason] = useState("");
  // The first OPEN obligation on this payment (closed ones stay as history).
  const obligation = r.open_obligation_ids?.[0] ?? r.obligation_ids?.[0] ?? null;
  const openObligation = r.open_obligation_ids?.[0] ?? null;
  const repaying = closeKind === "refunded_outside_razorpay";
  const paise = Math.round(Number(amountInr) * 100);
  const closeReady =
    closeReason.trim().length >= 20 &&
    reference.trim().length >= 4 &&
    (!repaying || (method !== "" && settledOn !== "" && Number.isFinite(paise) && paise > 0));
  return (
    <>
      <tr className="cursor-pointer border-t border-ink/10 align-top hover:bg-ink/[0.02]" onClick={toggle}>
        <td className="py-2 pr-3 font-mono text-xs">
          {r.order_id ? orderRef(r.order_id) : "—"}
          {r.backfilled && <span className="ml-1 rounded bg-ink/5 px-1 text-[10px] text-ink/50">before ledger</span>}
        </td>
        <td className="py-2 pr-3 font-mono text-xs">
          {r.channel === "outside_razorpay" ? "not via Razorpay" : r.razorpay_payment_id ?? "unknown (pre-0077)"}
          {r.provider_modes?.includes("test") && <span className="ml-1 text-[10px] text-ink/50">TEST</span>}
          {manual && (
            <div className="mt-0.5 font-sans text-[10px] text-amber-900">Manual payment — recorded by staff, not verified</div>
          )}
        </td>
        <td className="py-2 pr-3 text-right tabular-nums">{rupees(r.captured_paise)}</td>
        <td className="py-2 pr-3 text-right tabular-nums">{rupees(r.owed_paise)}</td>
        <td className="py-2 pr-3 text-right tabular-nums">
          {rupees(r.refunded_paise)}
          {r.pending_paise > 0 && <div className="text-[11px] text-amber-800">+{rupees(r.pending_paise)} pending</div>}
        </td>
        <td className="py-2 pr-3 text-right font-medium tabular-nums">{rupees(r.outstanding_paise)}</td>
        <td className="py-2 pr-3">
          <span className={`rounded px-2 py-0.5 text-xs ${TONE[st.tone]}`}>{st.label}</span>
          {st.why && <div className="mt-0.5 text-[10px] text-ink/50">{st.why}</div>}
          {(r.close_kinds ?? []).map((k) => (
            <div key={k} className="mt-0.5 text-[10px] text-ink/50">{CLOSE_LABEL[k] ?? k}</div>
          ))}
        </td>
        <td className="py-2 pr-3 text-xs text-ink/60">{when(r.last_verified_at)}</td>
      </tr>
      {isOpen && (
        <tr className="border-t border-ink/5 bg-ink/[0.02]">
          <td colSpan={8} className="space-y-4 p-4 text-sm">
            {(r.refunds ?? []).length > 0 && (
              <ul className="space-y-1">
                {(r.refunds ?? []).map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-xs">{f.razorpay_refund_id}</span>
                    <span className="text-xs">{f.status}</span>
                    <span className="tabular-nums">{rupees(f.amount_paise)}</span>
                    <span className="text-xs text-ink/50">
                      checked {when(f.last_verified_at)}
                      {f.last_verified_source ? ` (${f.last_verified_source})` : ""}
                    </span>
                    {f.uncertain_reason && <span className="text-xs text-terracotta">{f.uncertain_reason}</span>}
                    <button
                      disabled={!!busy}
                      onClick={() => void post(`v-${f.id}`, { action: "verify", refundId: f.razorpay_refund_id })}
                      className="inline-flex items-center gap-1 rounded border border-ink/20 px-2 py-0.5 text-xs hover:border-terracotta disabled:opacity-50"
                    >
                      {busy === `v-${f.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />} Check with Razorpay
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {r.channel === "razorpay" && obligation && r.open_obligations > 0 && r.outstanding_paise > 0 && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void post(`c-${r.ledger_key}`, { action: "claim", obligationId: obligation, refundId: refundId.trim(), note });
                  setRefundId("");
                  setNote("");
                }}
              >
                <label className="flex flex-col text-xs text-ink/60">
                  Razorpay refund id (from the dashboard)
                  <input
                    value={refundId}
                    onChange={(e) => setRefundId(e.target.value)}
                    placeholder="rfnd_…"
                    className="mt-1 w-56 rounded border border-ink/20 px-2 py-1 font-mono text-sm text-ink"
                  />
                </label>
                <label className="flex flex-col text-xs text-ink/60">
                  Note (optional)
                  <input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-64 rounded border border-ink/20 px-2 py-1 text-sm text-ink" />
                </label>
                <button
                  disabled={!!busy || !/^rfnd_[A-Za-z0-9]{6,40}$/.test(refundId.trim())}
                  className="rounded bg-ink px-3 py-1.5 text-xs uppercase tracking-widest text-white disabled:opacity-40"
                >
                  {busy === `c-${r.ledger_key}` ? "Checking…" : "Record and check"}
                </button>
              </form>
            )}

            {openObligation && r.outstanding_paise > 0 && !canClose && (
              <p className="text-xs text-ink/50">
                Only the owner or an authorised finance approver can close this without a verified Razorpay refund.
              </p>
            )}

            {openObligation && r.outstanding_paise > 0 && canClose && r.channel === "razorpay" && (
              <details className="text-xs">
                <summary className="cursor-pointer text-ink/60">Test-mode payment? Check with Razorpay…</summary>
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post(`t-${r.ledger_key}`, { action: "close_test_mode", obligationId: openObligation, reason: testReason });
                  }}
                >
                  <input
                    value={testReason}
                    onChange={(e) => setTestReason(e.target.value)}
                    placeholder="Why you believe it is Test-mode (20+ characters)"
                    className="w-96 rounded border border-ink/20 px-2 py-1"
                  />
                  <button disabled={!!busy || testReason.trim().length < 20} className="rounded border border-terracotta px-3 py-1 text-terracotta disabled:opacity-40">
                    {busy === `t-${r.ledger_key}` ? "Asking Razorpay…" : "Check Test mode with Razorpay"}
                  </button>
                </form>
                <p className="mt-1 text-ink/50">
                  The server asks Razorpay under Test keys. Only if Razorpay confirms a captured Test-mode payment on this
                  order is this one obligation closed — as “{LABELS.closed}”, never as refunded.
                </p>
              </details>
            )}

            {openObligation && r.outstanding_paise > 0 && canClose && (
              <details className="text-xs">
                <summary className="cursor-pointer text-ink/60">Close without a Razorpay refund (evidence required)…</summary>
                <form
                  className="mt-2 grid max-w-3xl grid-cols-1 gap-2 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post(`x-${r.ledger_key}`, {
                      action: "close",
                      obligationId: openObligation,
                      kind: closeKind,
                      reason: closeReason,
                      reference,
                      method: repaying ? method : null,
                      amountPaise: repaying ? paise : null,
                      settledOn: repaying ? settledOn : null,
                    });
                  }}
                >
                  <label className="flex flex-col text-ink/60">
                    What happened
                    <select value={closeKind} onChange={(e) => setCloseKind(e.target.value)} className="mt-1 rounded border border-ink/20 px-2 py-1">
                      <option value="refunded_outside_razorpay">Money returned outside Razorpay (cash / UPI / bank)</option>
                      {manual && <option value="no_funds_received">Manual order: no money was ever received</option>}
                    </select>
                  </label>
                  <label className="flex flex-col text-ink/60">
                    Evidence reference (UTR, UPI ref, receipt, document)
                    <input value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1 rounded border border-ink/20 px-2 py-1" />
                  </label>
                  {repaying && (
                    <>
                      <label className="flex flex-col text-ink/60">
                        Method
                        <select value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 rounded border border-ink/20 px-2 py-1">
                          <option value="">Choose…</option>
                          <option value="cash">Cash</option>
                          <option value="upi">UPI</option>
                          <option value="bank_transfer">Bank transfer</option>
                          <option value="card_offline">Card (offline terminal)</option>
                          <option value="other">Other</option>
                        </select>
                      </label>
                      <label className="flex flex-col text-ink/60">
                        Amount returned (₹) — must equal {rupees(r.outstanding_paise)}
                        <input value={amountInr} onChange={(e) => setAmountInr(e.target.value)} inputMode="decimal" className="mt-1 rounded border border-ink/20 px-2 py-1" />
                      </label>
                      <label className="flex flex-col text-ink/60">
                        Date returned
                        <input type="date" value={settledOn} onChange={(e) => setSettledOn(e.target.value)} className="mt-1 rounded border border-ink/20 px-2 py-1" />
                      </label>
                    </>
                  )}
                  <label className="flex flex-col text-ink/60 sm:col-span-2">
                    Why, and where the evidence is kept (20+ characters)
                    <input value={closeReason} onChange={(e) => setCloseReason(e.target.value)} className="mt-1 rounded border border-ink/20 px-2 py-1" />
                  </label>
                  <div className="sm:col-span-2">
                    <button disabled={!!busy || !closeReady} className="rounded border border-terracotta px-3 py-1 text-terracotta disabled:opacity-40">
                      Close as “{LABELS.closed}”
                    </button>
                  </div>
                </form>
                <p className="mt-1 text-ink/50">
                  Recorded permanently with your name and the evidence. It is never shown as “{LABELS.verified}”.
                </p>
              </details>
            )}

            {obligation && (
              <form
                className="flex items-end gap-2 text-xs"
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = (e.currentTarget.elements.namedItem("n") as HTMLInputElement).value;
                  void post(`n-${r.ledger_key}`, { action: "note", obligationId: obligation, note: t });
                  e.currentTarget.reset();
                }}
              >
                <input name="n" placeholder="Add a reconciliation note" className="w-96 rounded border border-ink/20 px-2 py-1" />
                <button disabled={!!busy} className="rounded border border-ink/20 px-2 py-1">Add note</button>
              </form>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function DiscrepancyItem({
  d,
  busy,
  post,
}: {
  d: Discrepancy;
  busy: string | null;
  post: (k: string, p: Record<string, unknown>) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  return (
    <li className="rounded border border-terracotta/30 p-3 text-sm">
      <div className="font-medium">{KIND_LABEL[d.kind] ?? d.kind}</div>
      <div className="mt-1 flex flex-wrap gap-3 font-mono text-xs text-ink/60">
        {d.order_id && <span>order {orderRef(d.order_id)}</span>}
        {d.razorpay_payment_id && <span>{d.razorpay_payment_id}</span>}
        {d.razorpay_refund_id && <span>{d.razorpay_refund_id}</span>}
        {d.provider_mode && <span>{d.provider_mode.toUpperCase()}</span>}
        <span>
          seen {d.times_seen}× · first {when(d.first_seen_at)}
        </span>
      </div>
      {d.latest_details && <pre className="mt-1 overflow-x-auto text-[11px] text-ink/50">{JSON.stringify(d.latest_details)}</pre>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was found and what was done (20+ characters)"
          className="w-96 rounded border border-ink/20 px-2 py-1"
        />
        <button
          disabled={!!busy || note.trim().length < 20}
          onClick={() => void post(`r-${d.id}`, { action: "resolve", discrepancyId: d.id, resolution: "resolved", note })}
          className="rounded border border-ink/20 px-2 py-1 disabled:opacity-40"
        >
          Resolved
        </button>
        <button
          disabled={!!busy || note.trim().length < 20}
          onClick={() => void post(`a-${d.id}`, { action: "resolve", discrepancyId: d.id, resolution: "accepted", note })}
          className="rounded border border-ink/20 px-2 py-1 disabled:opacity-40"
        >
          Accept as benign
        </button>
      </div>
    </li>
  );
}

function ReconcilePanel({
  runs,
  busy,
  post,
}: {
  runs: Run[];
  busy: string | null;
  post: (k: string, p: Record<string, unknown>) => Promise<void>;
}) {
  const iso = (d: Date) => d.toISOString().slice(0, 16);
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 7 * 86400_000)));
  const [to, setTo] = useState(() => iso(new Date(Date.now() - 20 * 60_000)));
  const resumable = runs.find((r) => r.status === "incomplete" || r.status === "failed");
  return (
    <section>
      <h2 className="mb-2 text-sm uppercase tracking-widest text-ink/60">Reconcile with Razorpay</h2>
      <p className="mb-2 max-w-3xl text-xs text-ink/60">
        Reads the payments Razorpay captured in a window (at most 31 days, ending at least 15 minutes ago) and compares
        them with Wovenne&apos;s records. It only reads Razorpay and only records findings — it never settles, refunds
        or changes an order.
      </p>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col text-ink/60">
          From (UTC)
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded border border-ink/20 px-2 py-1" />
        </label>
        <label className="flex flex-col text-ink/60">
          To (UTC)
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded border border-ink/20 px-2 py-1" />
        </label>
        <button
          disabled={!!busy}
          onClick={() => void post("recon", { action: "reconcile", from: `${from}:00Z`, to: `${to}:00Z` })}
          className="rounded bg-ink px-3 py-1.5 uppercase tracking-widest text-white disabled:opacity-40"
        >
          {busy === "recon" ? "Reading Razorpay…" : "Run"}
        </button>
        {resumable && (
          <button
            disabled={!!busy}
            onClick={() => void post("recon", { action: "reconcile", resumeFrom: resumable.id })}
            className="rounded border border-ink/20 px-3 py-1.5 disabled:opacity-40"
          >
            Resume run #{resumable.id}
          </button>
        )}
      </div>
      {runs.length > 0 && (
        <table className="mt-3 w-full text-left text-xs">
          <thead className="uppercase tracking-widest text-ink/50">
            <tr>
              <th className="py-1 pr-2">Run</th>
              <th className="py-1 pr-2">Mode</th>
              <th className="py-1 pr-2">Window</th>
              <th className="py-1 pr-2">Status</th>
              <th className="py-1 pr-2">Read</th>
              <th className="py-1 pr-2">Findings</th>
              <th className="py-1 pr-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-ink/10">
                <td className="py-1 pr-2">#{r.id}</td>
                <td className="py-1 pr-2">{r.provider_mode.toUpperCase()}</td>
                <td className="py-1 pr-2">
                  {when(r.window_from)} → {when(r.window_to)}
                </td>
                <td className={`py-1 pr-2 ${r.status === "complete" ? "text-emerald-800" : "text-terracotta"}`}>{r.status}</td>
                <td className="py-1 pr-2">
                  {r.payments_seen} ({r.captured_seen} captured)
                </td>
                <td className="py-1 pr-2">{r.discrepancies}</td>
                <td className="py-1 pr-2 text-ink/50">{r.last_error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

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
 * server asks Razorpay about it. "Refunded" on this screen only ever means
 * Razorpay said processed. Nothing here accepts an amount or a status.
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
};

const rupees = (paise: number | null | undefined) =>
  paise == null
    ? "—"
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(paise / 100);
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

function stateOf(r: LedgerRow): { label: string; tone: "red" | "amber" | "green" | "grey" } {
  if (r.uncertain_count > 0 || r.over_refunded_paise > 0) return { label: "Investigate — do not refund again", tone: "red" };
  if (r.open_discrepancies > 0) return { label: "Needs review", tone: "red" };
  if (r.pending_paise > 0) return { label: "Refund pending at Razorpay", tone: "amber" };
  if (r.claimed_count > 0) return { label: "Refund id not yet confirmed", tone: "amber" };
  if (r.outstanding_paise > 0) return { label: "Owed", tone: "red" };
  if (r.written_off_paise > 0) return { label: "Closed without verified refund", tone: "grey" };
  if (r.refunded_paise > 0) return { label: "Refunded (Razorpay: processed)", tone: "green" };
  return { label: "Nothing owed", tone: "grey" };
}
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [l, d, r] = await Promise.all([
      supabase.from("refund_ledger").select("*").order("first_owed_at", { ascending: true }),
      supabase.from("payment_reconciliation_discrepancies").select("*").eq("status", "open").order("first_seen_at"),
      supabase.from("payment_reconciliation_runs").select("*").order("id", { ascending: false }).limit(5),
    ]);
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
      outstanding: rows.reduce((s, r) => s + r.outstanding_paise, 0),
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
        Razorpay saying <em>processed</em> does.
      </p>

      {loadError && <p className="rounded bg-terracotta/10 p-3 text-sm text-terracotta">{loadError}</p>}
      {message && (
        <p role="status" className={`rounded p-3 text-sm ${message.bad ? "bg-terracotta/10 text-terracotta" : "bg-emerald-50 text-emerald-800"}`}>
          {message.text}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Outstanding", rupees(totals.outstanding)],
          ["Pending at Razorpay", rupees(totals.pending)],
          ["Verified refunded", rupees(totals.refunded)],
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
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {totals.backfilled > 0 && (
          <p className="mt-2 text-xs text-ink/50">
            {totals.backfilled} row(s) were brought in when the ledger was created (marked “before ledger”). Payments
            taken with Razorpay Test keys were never real money: close those as “Test-mode payment”.
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
}: {
  r: LedgerRow;
  st: ReturnType<typeof stateOf>;
  isOpen: boolean;
  toggle: () => void;
  busy: string | null;
  post: (k: string, p: Record<string, unknown>) => Promise<void>;
}) {
  const [refundId, setRefundId] = useState("");
  const [note, setNote] = useState("");
  const [closeKind, setCloseKind] = useState("test_mode_payment");
  const [closeReason, setCloseReason] = useState("");
  const obligation = r.obligation_ids?.[0] ?? null;
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

            {obligation && r.open_obligations > 0 && r.outstanding_paise > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-ink/60">Close without a Razorpay refund…</summary>
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post(`x-${r.ledger_key}`, { action: "close", obligationId: obligation, kind: closeKind, reason: closeReason });
                  }}
                >
                  <select value={closeKind} onChange={(e) => setCloseKind(e.target.value)} className="rounded border border-ink/20 px-2 py-1">
                    <option value="test_mode_payment">Test-mode payment (never real money)</option>
                    <option value="refunded_outside_razorpay">Refunded outside Razorpay (cash / bank)</option>
                  </select>
                  <input
                    value={closeReason}
                    onChange={(e) => setCloseReason(e.target.value)}
                    placeholder="Why, and where the evidence is (20+ characters)"
                    className="w-96 rounded border border-ink/20 px-2 py-1"
                  />
                  <button disabled={!!busy || closeReason.trim().length < 20} className="rounded border border-terracotta px-3 py-1 text-terracotta disabled:opacity-40">
                    Close as written off
                  </button>
                </form>
                <p className="mt-1 text-ink/50">Recorded as written off with your name. It is never shown as “refunded”.</p>
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

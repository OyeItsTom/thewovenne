/**
 * OS-3 (WP-ORDER-SAFETY-10): compare what Razorpay captured with what Wovenne
 * recorded. READ-ONLY towards Razorpay, RECORD-ONLY towards Wovenne.
 *
 * THE RISK IT CLOSES (OS-1). Razorpay captures a payment; the webhook's
 * settlement cannot reach the database; 24 hours of retries pass; the endpoint
 * gives up. The customer paid and Wovenne has no order, no obligation, nothing.
 * Only asking Razorpay "what did you capture?" finds that payment.
 *
 * WHAT IT ASKS. GET /v1/payments?from&to&count&skip — the provider interface
 * below has that one method and nothing else, so this code cannot capture,
 * refund or change anything at Razorpay. It never settles, fulfils, refunds,
 * issues a document or edits an amount here either: the database functions it
 * may call (recon_*, 0080) can only record a run, a checkpoint and a
 * discrepancy, and flag an order for review.
 *
 * PAGINATION AND RERUNS. Razorpay's list takes from/to (unix seconds),
 * count (≤ 100) and skip, and documents no sort order. So:
 *   * the window is fixed and ends at least 15 minutes ago (recon_start
 *     refuses otherwise): payments still arriving cannot shift the pages;
 *   * every page's work is recorded before the checkpoint moves (skip), and
 *     a discrepancy seen twice is counted on the same row, never duplicated —
 *     a rerun or a resumed run is safe;
 *   * the run is COMPLETE only when a short page proved the end was reached
 *     and every item had its key fields. A provider error, a timeout, a page
 *     budget used up, or a malformed item leaves it INCOMPLETE, with the
 *     checkpoint to resume from. Nothing here can declare a partial look clean.
 */
import type { ProviderMode, Rpc } from "./refundLedger";
import { withTimeout } from "./refundLedger";

export interface ListedPayment {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  captured?: unknown;
  order_id?: unknown;
  amount_refunded?: unknown;
}

/** The ONLY thing reconciliation may ask Razorpay. */
export interface PaymentLister {
  listPayments(q: { from: number; to: number; count: number; skip: number }): Promise<{ items?: unknown; count?: unknown }>;
}

export interface ReconcileDeps {
  provider: PaymentLister;
  rpc: Rpc;
  mode: ProviderMode | null;
  timeoutMs?: number;
}

export interface ReconcileOptions {
  from?: Date;
  to?: Date;
  resumeFrom?: number | null;
  actor?: string | null;
  /** Pages per invocation (a serverless request has a time limit). */
  maxPages?: number;
  pageSize?: number;
}

export interface ReconcileResult {
  ok: boolean;
  runId: number | null;
  status: "complete" | "incomplete" | "failed" | "not_started";
  pages: number;
  payments: number;
  captured: number;
  discrepancies: number;
  nextSkip: number | null;
  message: string;
}

interface Facts {
  orders: { razorpay_order_id: string; id: string; status: string; payment_status: string; razorpay_payment_id: string | null; total_paise: number | null }[];
  unfulfilled: { razorpay_payment_id: string; amount_paise: number }[];
  refunds: { razorpay_payment_id: string; counted_paise: number; processed_paise: number }[];
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export type Finding = { kind: string; payment: string; order: string | null; details: Record<string, unknown> };

/** Pure: what one captured payment says about Wovenne's records. */
export function classifyCaptured(
  p: { id: string; amount: number; order_id: string | null; amount_refunded: number; status: string },
  facts: Facts
): Finding[] {
  const out: Finding[] = [];
  const order = p.order_id ? facts.orders.find((o) => o.razorpay_order_id === p.order_id) : undefined;
  const owed = facts.unfulfilled.find((u) => u.razorpay_payment_id === p.id);
  const base = { amount_paise: p.amount, provider_status: p.status };

  if (!order) {
    if (!owed) out.push({ kind: "captured_unknown_order", payment: p.id, order: p.order_id, details: base });
  } else if (order.razorpay_payment_id === p.id) {
    if (order.total_paise !== null && order.total_paise !== p.amount) {
      out.push({ kind: "amount_mismatch", payment: p.id, order: p.order_id, details: { ...base, order_total_paise: order.total_paise } });
    }
  } else if (owed) {
    if (owed.amount_paise !== p.amount) {
      out.push({ kind: "amount_mismatch", payment: p.id, order: p.order_id, details: { ...base, owed_paise: owed.amount_paise } });
    }
  } else if (order.payment_status === "paid" && order.razorpay_payment_id === null) {
    // Settled before 0077 kept a payment id: matched by order and amount.
    if (order.total_paise !== null && order.total_paise !== p.amount) {
      out.push({ kind: "amount_mismatch", payment: p.id, order: p.order_id, details: { ...base, order_total_paise: order.total_paise, legacy: true } });
    }
  } else {
    out.push({
      kind: "captured_not_recorded",
      payment: p.id,
      order: p.order_id,
      details: { ...base, order_status: order.status, order_payment_status: order.payment_status, order_payment_id: order.razorpay_payment_id },
    });
  }

  const led = facts.refunds.find((r) => r.razorpay_payment_id === p.id);
  const counted = led?.counted_paise ?? 0;
  const processed = led?.processed_paise ?? 0;
  if (p.amount_refunded > counted) {
    out.push({ kind: "refund_not_in_ledger", payment: p.id, order: p.order_id, details: { provider_refunded_paise: p.amount_refunded, ledger_counted_paise: counted } });
  }
  if (processed > p.amount_refunded) {
    out.push({ kind: "ledger_exceeds_provider", payment: p.id, order: p.order_id, details: { provider_refunded_paise: p.amount_refunded, ledger_processed_paise: processed } });
  }
  return out;
}

export async function runReconciliation(opts: ReconcileOptions, deps: ReconcileDeps): Promise<ReconcileResult> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
  const maxPages = Math.min(Math.max(opts.maxPages ?? 5, 1), 50);
  const ms = deps.timeoutMs ?? 8000;
  const res: ReconcileResult = { ok: false, runId: null, status: "not_started", pages: 0, payments: 0, captured: 0, discrepancies: 0, nextSkip: null, message: "" };

  if (!deps.mode) {
    res.message = "This server's Razorpay key is neither Test nor Live; reconciliation did not start.";
    return res;
  }

  const started = await deps.rpc("recon_start", {
    p_mode: deps.mode,
    p_from: opts.from ? opts.from.toISOString() : null,
    p_to: opts.to ? opts.to.toISOString() : null,
    p_actor: opts.actor ?? null,
    p_resume_from: opts.resumeFrom ?? null,
  });
  if (started.error) {
    res.message = `Reconciliation did not start: ${started.error.message}`;
    return res;
  }
  const run = started.data as { id: number; window_from: string; window_to: string; next_skip: number };
  res.runId = run.id;
  const from = Math.floor(new Date(run.window_from).getTime() / 1000);
  const to = Math.floor(new Date(run.window_to).getTime() / 1000);
  let skip = run.next_skip;
  let exhausted = false;
  let dataIncomplete = false;

  const finish = async (status: "complete" | "incomplete" | "failed", message: string) => {
    const f = await deps.rpc("recon_finish", { p_run: run.id, p_status: status, p_error: status === "complete" ? null : message });
    if (f.error) {
      res.status = "failed";
      res.message = `${message} (and the run could not be closed: ${f.error.message}; it will be marked abandoned after 10 minutes)`;
    } else {
      res.status = status;
      res.message = message;
    }
    res.ok = res.status === "complete";
    res.nextSkip = skip;
    return res;
  };

  const record = async (kind: string, payment: string | null, order: string | null, details: Record<string, unknown>) => {
    const r = await deps.rpc("recon_record_discrepancy", {
      p_run: run.id, p_kind: kind, p_payment: payment, p_rzp_order: order, p_refund: null, p_details: details,
    });
    if (r.error) throw new Error(`could not record a discrepancy: ${r.error.message}`);
    res.discrepancies++;
  };

  try {
    for (let page = 0; page < maxPages; page++) {
      let listed: { items?: unknown };
      try {
        listed = await withTimeout(deps.provider.listPayments({ from, to, count: pageSize, skip }), ms);
      } catch (e) {
        return finish("incomplete", `Razorpay could not be read at skip ${skip} (${(e as Error).message ?? "error"}). Resume this run.`);
      }
      if (!listed || !Array.isArray(listed.items)) {
        return finish("incomplete", `Razorpay returned no payment list at skip ${skip}. Resume this run.`);
      }
      const items = listed.items as ListedPayment[];

      const captured: { id: string; amount: number; order_id: string | null; amount_refunded: number; status: string }[] = [];
      for (const it of items) {
        if (!it || !isStr(it.id) || !isInt(it.amount) || !isStr(it.currency) || typeof it.captured !== "boolean") {
          dataIncomplete = true;
          await record("provider_data_incomplete", isStr(it?.id) ? it.id : null, isStr(it?.order_id) ? it.order_id : null,
            { skip, item_keys: it && typeof it === "object" ? Object.keys(it) : [] });
          continue;
        }
        if (!it.captured) continue;
        if (it.currency !== "INR") {
          await record("amount_mismatch", it.id, isStr(it.order_id) ? it.order_id : null, { currency: it.currency, problem: "not INR" });
          continue;
        }
        captured.push({
          id: it.id,
          amount: it.amount,
          order_id: isStr(it.order_id) ? it.order_id : null,
          amount_refunded: isInt(it.amount_refunded) ? it.amount_refunded : 0,
          status: isStr(it.status) ? it.status : "unknown",
        });
      }

      if (captured.length) {
        const f = await deps.rpc("recon_payment_facts", {
          p_payment_ids: captured.map((c) => c.id),
          p_rzp_order_ids: captured.map((c) => c.order_id).filter((x): x is string => !!x),
        });
        if (f.error) throw new Error(`could not read Wovenne's records: ${f.error.message}`);
        const facts = f.data as Facts;
        for (const c of captured) {
          for (const finding of classifyCaptured(c, facts)) {
            await record(finding.kind, finding.payment, finding.order, finding.details);
          }
        }
      }

      exhausted = items.length < pageSize;
      skip += items.length;
      const cp = await deps.rpc("recon_checkpoint", {
        p_run: run.id, p_next_skip: skip, p_items: items.length, p_captured: captured.length,
        p_exhausted: exhausted, p_data_incomplete: dataIncomplete,
      });
      if (cp.error) throw new Error(`could not save the checkpoint: ${cp.error.message}`);
      res.pages++;
      res.payments += items.length;
      res.captured += captured.length;
      if (exhausted) break;
    }
  } catch (e) {
    return finish("failed", `Stopped: ${(e as Error).message}. Resume this run; nothing already recorded is lost.`);
  }

  if (dataIncomplete) {
    return finish("incomplete", "Some payments came back without key fields; recorded for investigation. The run is not complete.");
  }
  if (!exhausted) {
    return finish("incomplete", `Page budget used (${res.pages} pages). Resume this run to continue from skip ${skip}.`);
  }
  return finish("complete", `Complete: ${res.payments} payments read, ${res.captured} captured, ${res.discrepancies} discrepancies recorded.`);
}

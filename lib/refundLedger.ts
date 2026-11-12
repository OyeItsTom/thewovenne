/**
 * OS-3 (WP-ORDER-SAFETY-10): what Razorpay says about a refund, recorded.
 *
 * WOVENNE NEVER CREATES A REFUND. Refunds are started by a person in
 * Razorpay's dashboard. This module only ASKS Razorpay about a refund that
 * already exists — GET /v1/refunds/:id and GET /v1/payments/:id — and hands
 * Razorpay's answer to the database (record_refund_evidence, 0080). The
 * provider interface below has exactly those two reads; there is no method
 * through which this code could move money.
 *
 * ONE PATH, HOWEVER THE NEWS ARRIVES: the admin's "check with Razorpay", a
 * refund.* webhook, a reconciliation follow-up. All of them pass only a refund
 * id (plus, for the webhook, what the signed payload claimed, which is compared
 * and never trusted).
 *
 * The contract (Razorpay docs, checked 8 Nov 2026):
 *   refund   id rfnd_…, entity "refund", amount (paise, integer), currency,
 *            payment_id pay_…, created_at (unix s), status pending | processed
 *            | failed ("processed" is the only final success), speed_processed
 *            instant | normal (only when a speed was requested).
 *   payment  id, amount, currency, status created | authorized | captured |
 *            refunded | failed, captured (boolean), order_id, amount_refunded,
 *            refund_status null | partial | full.
 *   events   refund.created, refund.processed, refund.failed,
 *            refund.speed_changed — payload.refund.entity and
 *            payload.payment.entity. An automatic refund of a payment never
 *            captured has payment.captured = false.
 * Anything outside this — another status, a missing field — is NOT recorded:
 * it is reported, and a person looks.
 */

export type ProviderMode = "test" | "live";

/** Test or Live, from the API key this server uses. Anything else: unknown. */
export function providerModeFromKey(keyId: string | undefined | null): ProviderMode | null {
  if (!keyId) return null;
  if (keyId.startsWith("rzp_live_")) return "live";
  if (keyId.startsWith("rzp_test_")) return "test";
  return null;
}

export const REFUND_ID = /^rfnd_[A-Za-z0-9]{6,40}$/;
export const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const KNOWN_REFUND_STATUSES = ["pending", "processed", "failed"] as const;
export type RefundStatus = (typeof KNOWN_REFUND_STATUSES)[number];

export interface ProviderRefund {
  id?: unknown;
  entity?: unknown;
  amount?: unknown;
  currency?: unknown;
  payment_id?: unknown;
  created_at?: unknown;
  status?: unknown;
  speed_processed?: unknown;
}

export interface ProviderPayment {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  captured?: unknown;
  order_id?: unknown;
  amount_refunded?: unknown;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export interface RefundEvidence {
  refundId: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  status: RefundStatus;
  createdAt: string | null;
  speedProcessed: string | null;
}

/** A refund as Razorpay returned it, checked field by field. */
export function parseRefund(raw: ProviderRefund, expectedId: string):
  | { ok: true; refund: RefundEvidence }
  | { ok: false; problem: string } {
  if (!raw || typeof raw !== "object") return { ok: false, problem: "no refund object" };
  if (raw.id !== expectedId) return { ok: false, problem: `asked for ${expectedId}, got ${String(raw.id)}` };
  if (raw.entity !== undefined && raw.entity !== "refund") return { ok: false, problem: `entity ${String(raw.entity)}` };
  if (!isInt(raw.amount) || raw.amount <= 0) return { ok: false, problem: "amount is not a positive integer" };
  if (!isStr(raw.currency)) return { ok: false, problem: "no currency" };
  if (!isStr(raw.payment_id) || !PAYMENT_ID.test(raw.payment_id)) return { ok: false, problem: "no payment_id" };
  if (!isStr(raw.status)) return { ok: false, problem: "no status" };
  if (!(KNOWN_REFUND_STATUSES as readonly string[]).includes(raw.status)) {
    return { ok: false, problem: `unknown refund status ${raw.status}` };
  }
  return {
    ok: true,
    refund: {
      refundId: raw.id,
      paymentId: raw.payment_id,
      amountPaise: raw.amount,
      currency: raw.currency,
      status: raw.status as RefundStatus,
      createdAt: isInt(raw.created_at) ? new Date(raw.created_at * 1000).toISOString() : null,
      speedProcessed: isStr(raw.speed_processed) ? raw.speed_processed : null,
    },
  };
}

export interface PaymentEvidence {
  paymentId: string;
  orderId: string | null;
  amountPaise: number;
  currency: string;
  captured: boolean;
  amountRefundedPaise: number;
}

export function parsePayment(raw: ProviderPayment, expectedId: string):
  | { ok: true; payment: PaymentEvidence }
  | { ok: false; problem: string } {
  if (!raw || typeof raw !== "object") return { ok: false, problem: "no payment object" };
  if (raw.id !== expectedId) return { ok: false, problem: `asked for ${expectedId}, got ${String(raw.id)}` };
  if (!isInt(raw.amount) || raw.amount <= 0) return { ok: false, problem: "amount is not a positive integer" };
  if (!isStr(raw.currency)) return { ok: false, problem: "no currency" };
  if (typeof raw.captured !== "boolean") return { ok: false, problem: "captured is not a boolean" };
  if (raw.order_id !== null && raw.order_id !== undefined && !isStr(raw.order_id)) {
    return { ok: false, problem: "order_id is not a string" };
  }
  return {
    ok: true,
    payment: {
      paymentId: raw.id,
      orderId: isStr(raw.order_id) ? raw.order_id : null,
      amountPaise: raw.amount,
      currency: raw.currency,
      captured: raw.captured,
      amountRefundedPaise: isInt(raw.amount_refunded) ? raw.amount_refunded : 0,
    },
  };
}

/** What a signed webhook payload claimed, compared with the API's answer. */
export interface ClaimedRefund {
  refundId?: string | null;
  paymentId?: string | null;
  amountPaise?: number | null;
  currency?: string | null;
}

export function payloadMismatch(claimed: ClaimedRefund | undefined, refund: RefundEvidence): Record<string, unknown> | null {
  if (!claimed) return null;
  const diffs: Record<string, unknown> = {};
  if (claimed.paymentId && claimed.paymentId !== refund.paymentId) diffs.payment_id = { payload: claimed.paymentId, api: refund.paymentId };
  if (claimed.amountPaise != null && claimed.amountPaise !== refund.amountPaise) diffs.amount = { payload: claimed.amountPaise, api: refund.amountPaise };
  if (claimed.currency && claimed.currency !== refund.currency) diffs.currency = { payload: claimed.currency, api: refund.currency };
  return Object.keys(diffs).length ? diffs : null;
}

// ── Provider and database, injected ──────────────────────────────────────────

/** The ONLY things this module may ask Razorpay. Both are reads. */
export interface RefundProvider {
  fetchRefund(refundId: string): Promise<ProviderRefund>;
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
}

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

export interface RefundLedgerDeps {
  provider: RefundProvider;
  rpc: Rpc;
  mode: ProviderMode | null;
  /** Per call. A hung gateway must not hang the request. */
  timeoutMs?: number;
}

export type ProviderErrorKind = "not_found" | "indeterminate";

/**
 * Razorpay answers an unknown id with 400 BAD_REQUEST_ERROR "The id provided
 * does not exist" (or 404). Everything else — timeouts, 5xx, network — is
 * "could not ask", which never changes a record.
 */
export function classifyProviderError(e: unknown): ProviderErrorKind {
  const err = e as { statusCode?: number; error?: { code?: string; description?: string } } | null;
  const status = err?.statusCode;
  if (status === 404) return "not_found";
  if (status === 400) return "not_found";
  return "indeterminate";
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms}ms`), { timeout: true })), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export type VerifySource = "admin_verify" | "webhook" | "reconciliation";

export type VerifyResult =
  | {
      ok: true;
      outcome: "recorded" | "unchanged" | "stale_ignored" | "uncertain" | "ignored_uncaptured" | "refused_currency";
      status: string | null;
      reason: string | null;
      paymentRefundId: string | null;
      discrepancies: number[];
    }
  | {
      ok: false;
      /**
       * not_found       Razorpay does not know this id (in this mode). Recorded
       *                 as a discrepancy when the database can be reached.
       * indeterminate   could not ask Razorpay. Nothing written; try again.
       * invalid         Razorpay answered something this code does not
       *                 understand (unknown status, missing fields). Nothing
       *                 written; a person must look.
       * unconfigured    this server does not know whether it is Test or Live.
       * unrecorded      Razorpay answered, the database did not take it.
       */
      kind: "not_found" | "indeterminate" | "invalid" | "unconfigured" | "unrecorded" | "bad_id";
      message: string;
      discrepancyRecorded?: boolean;
    };

/**
 * Ask Razorpay about one refund and record its answer. Never creates, never
 * changes anything at Razorpay.
 */
export async function verifyAndRecordRefund(
  refundId: string,
  opts: { source: VerifySource; actor?: string | null; claimed?: ClaimedRefund },
  deps: RefundLedgerDeps
): Promise<VerifyResult> {
  const id = (refundId ?? "").trim();
  if (!REFUND_ID.test(id)) return { ok: false, kind: "bad_id", message: "That is not a Razorpay refund id (rfnd_…)." };
  if (!deps.mode) {
    return { ok: false, kind: "unconfigured", message: "This server's Razorpay key is neither a Test nor a Live key; nothing was checked." };
  }
  const ms = deps.timeoutMs ?? 8000;

  const notFound = async (paymentId: string | null, what: string): Promise<VerifyResult> => {
    const { error } = await deps.rpc("record_refund_not_found", {
      p_refund_id: id,
      p_payment_id: paymentId,
      p_mode: deps.mode,
      p_source: opts.source,
      p_details: { what, claimed: opts.claimed ?? null },
    });
    return {
      ok: false,
      kind: "not_found",
      message: `Razorpay (${deps.mode}) has no ${what}. Check the id, and that it is a ${deps.mode === "live" ? "Live" : "Test"}-mode refund.`,
      discrepancyRecorded: !error,
    };
  };

  let rawRefund: ProviderRefund;
  try {
    rawRefund = await withTimeout(deps.provider.fetchRefund(id), ms);
  } catch (e) {
    if (classifyProviderError(e) === "not_found") return notFound(opts.claimed?.paymentId ?? null, `refund ${id}`);
    return { ok: false, kind: "indeterminate", message: "Could not reach Razorpay to check the refund. Nothing was changed; try again." };
  }
  const refund = parseRefund(rawRefund, id);
  if (!refund.ok) {
    return { ok: false, kind: "invalid", message: `Razorpay's answer for ${id} was not understood (${refund.problem}). Nothing was recorded.` };
  }

  let rawPayment: ProviderPayment;
  try {
    rawPayment = await withTimeout(deps.provider.fetchPayment(refund.refund.paymentId), ms);
  } catch (e) {
    if (classifyProviderError(e) === "not_found") return notFound(refund.refund.paymentId, `payment ${refund.refund.paymentId}`);
    return { ok: false, kind: "indeterminate", message: "Could not reach Razorpay to check the payment. Nothing was changed; try again." };
  }
  const payment = parsePayment(rawPayment, refund.refund.paymentId);
  if (!payment.ok) {
    return { ok: false, kind: "invalid", message: `Razorpay's answer for payment ${refund.refund.paymentId} was not understood (${payment.problem}). Nothing was recorded.` };
  }

  const r = refund.refund;
  const p = payment.payment;
  const { data, error } = await deps.rpc("record_refund_evidence", {
    p_refund_id: r.refundId,
    p_payment_id: p.paymentId,
    p_payment_order_id: p.orderId,
    p_amount_paise: r.amountPaise,
    p_currency: r.currency,
    p_status: r.status,
    p_created_at: r.createdAt,
    p_speed_processed: r.speedProcessed,
    p_payment_amount_paise: p.amountPaise,
    p_payment_currency: p.currency,
    p_payment_captured: p.captured,
    p_payment_amount_refunded_paise: p.amountRefundedPaise,
    p_provider_mode: deps.mode,
    p_source: opts.source,
    p_actor: opts.actor ?? null,
    p_payload_mismatch: payloadMismatch(opts.claimed, r),
  });
  if (error) {
    console.error(`Refund ${id}: Razorpay answered but the ledger refused or was unreachable: ${error.message}`);
    return { ok: false, kind: "unrecorded", message: "Razorpay answered, but the ledger could not record it. Nothing was changed; try again." };
  }
  const res = (data ?? {}) as {
    outcome?: string;
    status?: string | null;
    reason?: string | null;
    payment_refund_id?: string | null;
    discrepancies?: number[] | null;
  };
  return {
    ok: true,
    outcome: (res.outcome ?? "recorded") as Extract<VerifyResult, { ok: true }>["outcome"],
    status: res.status ?? null,
    reason: res.reason ?? null,
    paymentRefundId: res.payment_refund_id ?? null,
    discrepancies: res.discrepancies ?? [],
  };
}

// ── Webhook ──────────────────────────────────────────────────────────────────

export const REFUND_EVENTS = ["refund.created", "refund.processed", "refund.failed", "refund.speed_changed"] as const;

export interface RefundWebhookEvent {
  event?: string;
  payload?: {
    refund?: { entity?: { id?: unknown; payment_id?: unknown; amount?: unknown; currency?: unknown; status?: unknown } };
    payment?: { entity?: { id?: unknown; captured?: unknown } };
  };
}

/** Which refund, if any, a verified refund.* event is about. Only the id is used. */
export function refundWebhookTarget(event: RefundWebhookEvent):
  | { act: true; refundId: string; claimed: ClaimedRefund }
  | { act: false; reason: string } {
  const type = event?.event ?? "";
  if (!type.startsWith("refund.")) return { act: false, reason: "not a refund event" };
  if (!(REFUND_EVENTS as readonly string[]).includes(type)) {
    // A refund event this code does not know. Still a refund: ask about it.
    console.warn(`Unknown refund webhook event ${type}; checking the refund with Razorpay anyway.`);
  }
  const ent = event.payload?.refund?.entity;
  const id = ent?.id;
  if (typeof id !== "string" || !REFUND_ID.test(id)) return { act: false, reason: "incomplete refund payload" };
  return {
    act: true,
    refundId: id,
    claimed: {
      refundId: id,
      paymentId: typeof ent?.payment_id === "string" ? ent.payment_id : null,
      amountPaise: typeof ent?.amount === "number" ? ent.amount : null,
      currency: typeof ent?.currency === "string" ? ent.currency : null,
    },
  };
}

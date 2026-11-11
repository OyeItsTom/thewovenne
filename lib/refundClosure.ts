import {
  classifyProviderError,
  parsePayment,
  withTimeout,
  type PaymentEvidence,
  type ProviderMode,
  type ProviderPayment,
  type Rpc,
} from "./refundLedger";

/**
 * Closing a Test-mode obligation (WP-ORDER-SAFETY-12, owner decision O3-1).
 *
 * A payment taken with Razorpay TEST keys was never real money, but saying so
 * is not enough: the server asks Razorpay, under Test keys, for the payment
 * (or, for an order settled before 0077, the order's payments) and hands that
 * answer to record_test_mode_closure, which also requires that the person is
 * an enrolled owner / finance approver. One obligation per call. It is shown
 * as "Closed without verified refund", never as refunded.
 *
 * Only GETs: payments.fetch and orders.fetchPayments.
 */
export interface TestModeProvider {
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  fetchOrderPayments(orderId: string): Promise<{ items?: unknown }>;
}

export interface TestModeDeps {
  provider: TestModeProvider;
  rpc: Rpc;
  mode: ProviderMode | null;
  timeoutMs?: number;
}

export interface TestModeInput {
  obligationId: string;
  actor: string;
  reason: string;
  /** The obligation's payment, or null for an order settled before 0077. */
  paymentId: string | null;
  razorpayOrderId: string;
}

export type TestModeResult =
  | { ok: true; paymentId: string; writtenOffPaise: number }
  | { ok: false; kind: "not_test_keys" | "not_found" | "indeterminate" | "invalid" | "ambiguous" | "refused"; message: string };

export async function closeTestModeObligation(input: TestModeInput, deps: TestModeDeps): Promise<TestModeResult> {
  if (deps.mode !== "test") {
    return {
      ok: false,
      kind: "not_test_keys",
      message: "This server is not using Razorpay Test keys, so it cannot confirm a Test-mode payment. Nothing was closed.",
    };
  }
  if (input.reason.trim().length < 20) {
    return { ok: false, kind: "invalid", message: "Write at least 20 characters saying why." };
  }
  const ms = deps.timeoutMs ?? 8000;

  let payment: PaymentEvidence;
  let status: string | null = null;
  try {
    if (input.paymentId) {
      const raw = await withTimeout(deps.provider.fetchPayment(input.paymentId), ms);
      const parsed = parsePayment(raw, input.paymentId);
      if (!parsed.ok) return { ok: false, kind: "invalid", message: `Razorpay's answer was not understood (${parsed.problem}). Nothing was closed.` };
      payment = parsed.payment;
      status = typeof raw.status === "string" ? raw.status : null;
    } else {
      const list = await withTimeout(deps.provider.fetchOrderPayments(input.razorpayOrderId), ms);
      if (!list || !Array.isArray(list.items)) {
        return { ok: false, kind: "invalid", message: "Razorpay's list of payments for this order was not understood. Nothing was closed." };
      }
      const captured: { p: PaymentEvidence; status: string | null }[] = [];
      for (const item of list.items as ProviderPayment[]) {
        const parsed = parsePayment(item, String(item?.id ?? ""));
        if (!parsed.ok) return { ok: false, kind: "invalid", message: `A payment on this order was not understood (${parsed.problem}). Nothing was closed.` };
        if (parsed.payment.captured) captured.push({ p: parsed.payment, status: typeof item.status === "string" ? item.status : null });
      }
      if (captured.length === 0) {
        return { ok: false, kind: "not_found", message: "Razorpay (Test mode) shows no captured payment on this order. Investigate; nothing was closed." };
      }
      if (captured.length > 1) {
        return {
          ok: false,
          kind: "ambiguous",
          message: `Razorpay (Test mode) shows ${captured.length} captured payments on this order. Investigate which one this is; nothing was closed.`,
        };
      }
      payment = captured[0].p;
      status = captured[0].status;
    }
  } catch (e) {
    if (classifyProviderError(e) === "not_found") {
      return {
        ok: false,
        kind: "not_found",
        message: "Razorpay's Test mode does not know this payment. It may be a Live payment: do not close it as Test-mode.",
      };
    }
    return { ok: false, kind: "indeterminate", message: "Could not reach Razorpay. Nothing was closed; try again." };
  }

  if (payment.orderId !== input.razorpayOrderId) {
    return { ok: false, kind: "refused", message: "Razorpay says this payment belongs to a different order. Nothing was closed." };
  }

  const { data, error } = await deps.rpc("record_test_mode_closure", {
    p_obligation_id: input.obligationId,
    p_actor: input.actor,
    p_reason: input.reason.trim(),
    p_provider_mode: deps.mode,
    p_payment_id: payment.paymentId,
    p_payment_order_id: payment.orderId,
    p_payment_amount_paise: payment.amountPaise,
    p_payment_currency: payment.currency,
    p_payment_captured: payment.captured,
    p_payment_status: status,
  });
  if (error) return { ok: false, kind: "refused", message: error.message };
  const r = data as { written_off_paise?: number | string } | null;
  return { ok: true, paymentId: payment.paymentId, writtenOffPaise: Number(r?.written_off_paise ?? 0) };
}

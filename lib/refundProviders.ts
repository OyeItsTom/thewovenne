import { razorpay } from "./razorpay";
import { createServiceClient } from "./supabase";
import {
  providerModeFromKey,
  type ProviderPayment,
  type ProviderRefund,
  type RefundLedgerDeps,
  type Rpc,
} from "./refundLedger";
import type { ReconcileDeps } from "./paymentReconciliation";
import type { TestModeDeps } from "./refundClosure";

/**
 * Production wiring for OS-3. The only Razorpay calls made anywhere in the
 * refund ledger and reconciliation are the four below, and all four are
 * GETs: fetch a refund, fetch a payment, list payments, and (for the
 * Test-mode closure check, WP-12) list one order's payments. Nothing here can
 * create a refund, capture a payment or change anything at Razorpay.
 *
 * The service client is used only for the 0080 service_role functions; the
 * caller has already established who is asking (webhook signature, or an
 * admin's aal2 session checked by the route).
 */
function serviceRpc(): Rpc {
  const sb = createServiceClient();
  return async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args);
    return { data, error: error ? { message: error.message, code: error.code } : null };
  };
}

export function refundLedgerDeps(): RefundLedgerDeps {
  return {
    provider: {
      fetchRefund: (id) => razorpay.refunds.fetch(id) as unknown as Promise<ProviderRefund>,
      fetchPayment: (id) => razorpay.payments.fetch(id) as unknown as Promise<ProviderPayment>,
    },
    rpc: serviceRpc(),
    mode: providerModeFromKey(process.env.RAZORPAY_KEY_ID),
  };
}

export function reconcileDeps(): ReconcileDeps {
  return {
    provider: {
      listPayments: (q) => razorpay.payments.all(q) as unknown as Promise<{ items?: unknown; count?: unknown }>,
    },
    rpc: serviceRpc(),
    mode: providerModeFromKey(process.env.RAZORPAY_KEY_ID),
  };
}

/** The Test-mode closure check (WP-12): two reads, under the server's own key. */
export function testModeDeps(): TestModeDeps {
  return {
    provider: {
      fetchPayment: (id) => razorpay.payments.fetch(id) as unknown as Promise<ProviderPayment>,
      fetchOrderPayments: (id) => razorpay.orders.fetchPayments(id) as unknown as Promise<{ items?: unknown }>,
    },
    rpc: serviceRpc(),
    mode: providerModeFromKey(process.env.RAZORPAY_KEY_ID),
  };
}

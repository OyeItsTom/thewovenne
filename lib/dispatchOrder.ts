import { checkConsignment, INDIA_POST_COURIER_CODE, INDIA_POST_LABEL } from "./couriers/indiaPost";
import { shipmentEmailView, type ShipmentEmailRow, type ShipmentEmailView } from "./shipmentEmailState";
import type { AttemptOutcome } from "./orderConfirmationDelivery";

/**
 * Dispatching an order to India Post Speed Post, server side (WP-EMAIL-E3c).
 * The route (app/api/admin/orders/dispatch) checks where the request came from
 * and that the admin session is live, then hands over to this.
 *
 * WHO DECIDES WHAT.
 *   - The number: checked again here (lib/couriers/indiaPost), whatever the
 *     browser showed. An unusual number goes ahead only if the request
 *     confirms THAT EXACT normalised number, so a confirmation cannot carry
 *     over to a number that was edited afterwards. The database checks it a
 *     third time and refuses an unusual number unless told it was confirmed.
 *   - Everything else — admin, two factors, paid, status, address, one
 *     dispatch, one email intent — is dispatch_order() in the database,
 *     called with the admin's OWN session, never the service key.
 *
 * THE EMAIL. dispatch_order() records the intent in the same transaction as
 * the dispatch. This then makes one bounded attempt through R1 and reports
 * what Resend actually said. If that attempt fails, times out, or this
 * process dies before it starts, the dispatch stands and the row stays due:
 * R1's recovery worker sends it, and so does a repeat of this request (it
 * returns already_dispatched and attempts the same row — the key is fixed, so
 * it cannot arrive twice).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcResult = { data: unknown; error: { code?: string; message: string; hint?: string | null } | null };

export interface DispatchDeps {
  /** The admin's own session. Never the service key: dispatch_order asks is_admin(). */
  session: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };
  /** One R1 attempt at a delivery row (attemptOrderConfirmation). Never throws in production. */
  attempt: (deliveryId: string) => Promise<AttemptOutcome>;
  /** The delivery row's status columns, read server side. */
  readEmail: (deliveryId: string) => Promise<ShipmentEmailRow | null>;
}

export interface DispatchRequestBody {
  orderId?: unknown;
  consignment?: unknown;
  /** The normalised number the admin was shown the warning for and confirmed. */
  confirmUnusual?: unknown;
}

export type DispatchReply =
  | {
      status: 200;
      body: {
        ok: true;
        outcome: "dispatched" | "already_dispatched";
        courier: string;
        consignment: string;
        email: ShipmentEmailView;
        /** What the one attempt in this request did, or null if none was made. */
        attempt: AttemptOutcome | null;
      };
    }
  | {
      status: 400 | 403 | 404 | 409 | 500 | 503;
      body: {
        ok: false;
        error: string;
        needsConfirmation?: true;
        consignment?: string;
        note?: string | null;
      };
    };

const REFUSED_NUMBER: Record<string, string> = {
  empty: "Enter the consignment number from the India Post booking receipt.",
  too_long: "That is longer than any consignment number (30 characters at most).",
  invalid_characters: "A consignment number is letters and digits only.",
};

const fail = (status: 400 | 403 | 404 | 409 | 500 | 503, error: string, extra: object = {}): DispatchReply => ({
  status,
  body: { ok: false, error, ...extra },
});

export async function performDispatch(req: DispatchRequestBody, deps: DispatchDeps): Promise<DispatchReply> {
  if (typeof req.orderId !== "string" || !UUID.test(req.orderId)) return fail(400, "No order given.");
  const orderId = req.orderId;

  if (typeof req.consignment !== "string") return fail(400, REFUSED_NUMBER.empty);
  const number = checkConsignment(req.consignment);
  if (!number.ok) return fail(400, REFUSED_NUMBER[number.reason]);

  const confirmed = number.needsConfirmation && req.confirmUnusual === number.value;
  if (number.needsConfirmation && !confirmed) {
    return fail(409, "This number needs confirming before dispatch.", {
      needsConfirmation: true,
      consignment: number.value,
      note: number.note,
    });
  }

  const { data, error } = await deps.session.rpc("dispatch_order", {
    p_order_id: orderId,
    p_courier: INDIA_POST_COURIER_CODE,
    p_consignment: number.value,
    p_confirm_unusual: confirmed,
  });
  if (error) {
    // dispatch_order's refusals are written to be read; passed through.
    if (error.hint === "needs_confirmation") {
      return fail(409, error.message, { needsConfirmation: true, consignment: number.value, note: number.note });
    }
    if (error.code === "42501") return fail(403, "Not authorised.");
    // The code is live but 0075 is not applied yet (the two ship together; this
    // is only the gap between the deploy and the migration). Nothing changed.
    if (error.code === "PGRST202" || error.code === "42883") {
      return fail(503, "Dispatch is not available yet (migration 0075 is not applied). Nothing was changed.");
    }
    if (error.code === "P0002") return fail(404, error.message);
    if (error.code === "55000" || error.code === "22023") return fail(409, error.message);
    console.error(`Dispatch ${orderId}: dispatch_order failed (${error.code ?? "?"}).`);
    return fail(500, "The dispatch could not be recorded. Nothing was changed; try again.");
  }

  const result = (data ?? {}) as { outcome?: string; delivery_id?: string | null; email?: string };
  if (result.outcome !== "dispatched" && result.outcome !== "already_dispatched") {
    console.error(`Dispatch ${orderId}: unexpected reply from dispatch_order.`);
    return fail(500, "The database gave an unexpected answer. Refresh to see the order as it is.");
  }

  // ── The email: one bounded attempt, never fatal ──
  let attempt: AttemptOutcome | null = null;
  let email: ShipmentEmailView;
  if (result.delivery_id) {
    try {
      attempt = await deps.attempt(result.delivery_id);
    } catch (e) {
      console.error(`Dispatch ${orderId}: the email attempt threw:`, e instanceof Error ? e.message : "unknown");
      attempt = "error";
    }
    let row: ShipmentEmailRow | null = null;
    try {
      row = await deps.readEmail(result.delivery_id);
    } catch {
      row = null;
    }
    email = row
      ? shipmentEmailView(row)
      : { state: "queued", label: "Shipping email recorded", detail: "Its status could not be read just now; refresh to see it." };
  } else {
    email = shipmentEmailView(null, { inPerson: result.email === "in_person" });
  }

  return {
    status: 200,
    body: {
      ok: true,
      outcome: result.outcome,
      courier: INDIA_POST_LABEL,
      consignment: number.value,
      email,
      attempt,
    },
  };
}

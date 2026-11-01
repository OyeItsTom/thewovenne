/**
 * What happened to an order's shipping email, in the admin's words
 * (WP-EMAIL-E3c).
 *
 * Read from the order_email_deliveries row (0074/0075) through
 * shipment_email_status(). NEVER "delivered": Resend accepting a message
 * means it took responsibility for it, not that it reached the inbox, and
 * nothing here can see further than that.
 */

export type ShipmentEmailState =
  /** Recorded, no attempt yet — or one is running now. */
  | "queued"
  /** Resend accepted it. Not the same as delivered. */
  | "accepted"
  /** Not accepted yet; it will be tried again automatically. */
  | "retry"
  /** Stopped trying. Someone needs to look. */
  | "needs_attention"
  /** The order has no email address. */
  | "no_recipient"
  /** No shipping email exists for this order, by design. */
  | "none";

export interface ShipmentEmailRow {
  status: string;
  possibly_accepted: boolean;
  attempts: number;
  last_error_code: string | null;
}

export interface ShipmentEmailView {
  state: ShipmentEmailState;
  label: string;
  detail: string | null;
}

const LABEL: Record<ShipmentEmailState, string> = {
  queued: "Shipping email queued",
  accepted: "Shipping email accepted by Resend",
  retry: "Shipping email: retry required",
  needs_attention: "Shipping email failed — needs attention",
  no_recipient: "No shipping email — no email address",
  none: "No shipping email",
};

/** Why a row stopped, in words; unknown codes are shown as they are. */
const REASON: Record<string, string> = {
  order_cancelled: "the order was cancelled before it went",
  not_dispatched: "the order was no longer dispatched",
  invalid_dispatch: "the dispatch record did not match what was sent",
  customer_anonymised: "the customer deleted their account",
  order_missing: "the order no longer exists",
  render_failed: "the email could not be built",
  unknown_kind: "this build does not know that kind of email",
  not_configured: "email is not configured on this server",
};

function reason(code: string | null): string | null {
  if (!code) return null;
  return REASON[code] ?? code;
}

export function shipmentEmailView(
  row: ShipmentEmailRow | null,
  context: { inPerson?: boolean } = {}
): ShipmentEmailView {
  if (!row) {
    return {
      state: "none",
      label: LABEL.none,
      detail: context.inPerson
        ? "In-person orders are never emailed automatically."
        : "Dispatched before shipping emails existed, or not dispatched here.",
    };
  }
  switch (row.status) {
    case "pending":
      return { state: "queued", label: LABEL.queued, detail: row.attempts > 0 ? null : "Not attempted yet." };
    case "sending":
      return { state: "queued", label: LABEL.queued, detail: "An attempt is running now." };
    case "accepted":
      return {
        state: "accepted",
        label: LABEL.accepted,
        detail: "Resend took the message. Whether it reached the inbox is not something we can see.",
      };
    case "retryable":
      return { state: "retry", label: LABEL.retry, detail: reason(row.last_error_code) ?? "Resend did not accept it; it will be tried again." };
    case "uncertain":
      return {
        state: "retry",
        label: LABEL.retry,
        detail: "No clear answer from Resend (it may have been accepted). The retry uses the same key, so it cannot arrive twice.",
      };
    case "failed":
      if (row.last_error_code === "no_recipient") {
        return { state: "no_recipient", label: LABEL.no_recipient, detail: "Nobody was told. Contact the customer another way if you need to." };
      }
      return {
        state: "needs_attention",
        label: LABEL.needs_attention,
        detail: [
          reason(row.last_error_code),
          row.possibly_accepted ? "It may still have reached the customer" : null,
        ].filter(Boolean).join(". ") || null,
      };
    case "expired":
      return {
        state: "needs_attention",
        label: LABEL.needs_attention,
        detail: row.possibly_accepted
          ? "Stopped retrying; an earlier attempt may have reached the customer."
          : "Stopped retrying; it was never accepted.",
      };
    default:
      return { state: "needs_attention", label: LABEL.needs_attention, detail: `Unrecognised status ${row.status}.` };
  }
}

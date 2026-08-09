/**
 * How an order was paid for.
 *
 * The list lives here and matches the CHECK constraint in migration 0044
 * exactly — if one changes, both must. "razorpay" is deliberately absent from
 * OFFLINE_METHODS: it is a real payment method but not one an admin can choose,
 * because choosing it would claim a gateway payment that never happened and
 * make the order look like it was missing its fee.
 */

export type PaymentMethod =
  | "razorpay"
  | "cash"
  | "upi"
  | "card_offline"
  | "bank_transfer"
  | "other";

export const OFFLINE_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "cash", label: "Cash" },
  { id: "upi", label: "UPI" },
  { id: "card_offline", label: "Card (offline terminal)" },
  { id: "bank_transfer", label: "Bank transfer" },
  { id: "other", label: "Other" },
];

const LABELS: Record<PaymentMethod, string> = {
  razorpay: "Razorpay (online)",
  cash: "Cash",
  upi: "UPI",
  card_offline: "Card (offline terminal)",
  bank_transfer: "Bank transfer",
  other: "Other",
};

export function paymentMethodLabel(method: string | null): string {
  if (!method) return "—";
  return LABELS[method as PaymentMethod] ?? method;
}

/** True when this order carries no gateway fee by definition. */
export function isOffline(method: string | null): boolean {
  return Boolean(method) && method !== "razorpay";
}

type ClassValue = string | number | null | boolean | undefined;

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(" ");
}

/**
 * Format a price in Indian Rupees, e.g. 1899 → "₹1,899". No decimals — prices
 * are whole-rupee. The `price_inr` / `total_inr` fields hold the base amount.
 *
 * FUTURE UPGRADE — multi-currency + PayPal:
 * We currently show ₹ INR to everyone (launching in Kerala, India first). The
 * planned upgrade is to detect the visitor's region and show ₹ to India and £
 * (GBP) to the UK, with PayPal re-enabled for UK checkout alongside Razorpay.
 * To add it later: introduce a display layer here (e.g. formatMoney(amount,
 * currency) + a conversion table), branch the checkout provider by region, and
 * re-enable the PayPal button/route + env keys (see the TODO(payments) markers
 * in CartSummary, lib/types, and .env.local.example).
 */
export function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

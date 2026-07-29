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

/**
 * Turn a display name into a URL-safe slug: "Nehru Jackets" → "nehru-jackets".
 * Strips accents so "Café Linen" → "cafe-linen" rather than dropping the é.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    // Drop apostrophes rather than turning them into separators, so
    // "Men's Shirts" reads as "mens-shirts" not "men-s-shirts".
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * slugify, then suffix -2, -3… until it no longer collides with `taken`.
 * Slugs are public URLs and unique in the database, so a clash is a hard error
 * rather than something to discover on save.
 */
export function uniqueSlug(input: string, taken: string[]): string {
  const base = slugify(input);
  if (!base) return "";
  const used = new Set(taken);
  if (!used.has(base)) return base;

  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

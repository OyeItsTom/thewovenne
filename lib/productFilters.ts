import type { Product } from "./types";
import type { ProductSize } from "./sizes";
import type { Filters } from "@/components/shop/FilterSidebar";

/**
 * Which products match a set of filters, and which options are worth offering.
 *
 * Shared between the shop-wide listing and each sub-category listing so the two
 * cannot answer the same question differently.
 */

export type SizesByProduct = Record<string, ProductSize[]>;

/**
 * Sizes worth offering: only those some product still HAS stock in.
 *
 * Offering a size that is sold out everywhere gives a filter that always
 * returns nothing, which reads as a broken page rather than an empty shelf.
 * (A sold-out size is still shown on the product page itself — there it
 * answers a different question.)
 */
export function availableSizes(
  products: Array<Pick<Product, "id">>,
  sizesByProduct: SizesByProduct
): string[] {
  const labels = new Map<string, number>();
  for (const p of products) {
    for (const size of sizesByProduct[p.id] ?? []) {
      if (size.stock_quantity > 0) {
        labels.set(size.label, Math.min(labels.get(size.label) ?? 999, size.sort_order));
      }
    }
  }
  // Ordered as the admin ordered them, not alphabetically — S, M, L, XL is a
  // run, and sorting it as text gives L, M, S, XL.
  return [...labels.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}

/** Distinct non-empty values of a free-text attribute, case-insensitively. */
export function distinctValues(
  products: Product[],
  pick: (p: Product) => string | null
): string[] {
  const seen = new Map<string, string>();
  for (const p of products) {
    const v = pick(p)?.trim();
    // Keyed lower-case so "Indigo" and "indigo" are one option, displayed with
    // the first spelling seen. The real fix is normalising the data, but a
    // filter list that fragments as the catalogue grows is worse.
    if (v) seen.set(v.toLowerCase(), seen.get(v.toLowerCase()) ?? v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const same = (a: string | null, b: string | null) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export function matchesFilters(
  product: Product,
  filters: Filters,
  sizesByProduct: SizesByProduct
): boolean {
  if (filters.category && product.category_slug !== filters.category) return false;
  if (filters.fabric && !same(product.fabric, filters.fabric)) return false;
  if (filters.colour && !same(product.colour, filters.colour)) return false;
  if (filters.maxPrice && product.price_inr > filters.maxPrice) return false;

  if (filters.size) {
    // Stock, not just existence: filtering by M should not surface a product
    // that lists M and has none of it.
    const sizes = sizesByProduct[product.id] ?? [];
    const match = sizes.find((s) => same(s.label, filters.size));
    if (!match || match.stock_quantity <= 0) return false;
  }

  return true;
}

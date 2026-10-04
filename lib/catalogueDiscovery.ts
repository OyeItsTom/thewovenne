import type { ProductListing } from "./types";
import { effectivePrice } from "./pricing";
import { stockState } from "./stock";
import { formatINR } from "./utils";
import {
  NO_FILTERS,
  type CatalogueFilters,
  type CatalogueSort,
} from "./catalogueParams";

/**
 * How a listing presents what it holds: its order, its count, the filters it
 * offers and the ones a customer has chosen.
 *
 * ONE MODULE FOR EVERY LISTING. The shop orders and counts on the server, a
 * category page in the browser, and before this each had its own idea of both —
 * the shop showed no count at all, a sub-category showed "8 of 30" only once
 * filtered, a section page showed neither. These functions are the answer to
 * each of those questions, used everywhere, so the pages cannot drift apart
 * again.
 *
 * PURE: no React, no Next, no database. Tested in
 * scripts/catalogue-discovery.test.ts.
 */

/** What ordering needs to know about a product. */
type Orderable = Pick<
  ProductListing,
  | "price_inr"
  | "stock_quantity"
  | "discount_type"
  | "discount_value"
  | "discount_starts_at"
  | "discount_ends_at"
>;

/** The sort control's options, default first. "newest" is never written to a URL. */
export const SORT_OPTIONS: readonly { value: CatalogueSort | "newest"; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
];

/**
 * A listing's order: what can be bought first, sold-out pieces after.
 *
 * AVAILABILITY IS PRIMARY, WHATEVER THE SORT. A customer who asks for "lowest
 * price first" is asking for the cheapest thing they can buy, and a sold-out
 * ₹1,250 saree in first place answers a different question. So the chosen sort
 * applies inside each group. Sold-out pieces are never dropped — their pages
 * still exist and they still say "Sold out" — they are only moved.
 *
 * STABLE. Within a group, ties keep the order the products arrived in, which is
 * newest product first from every catalogue query. That is what "Newest" is:
 * the order that was already there, not a second date comparison that could
 * disagree with the database's.
 *
 * Price is the price SHOWN on the card (a live discount included), so the order
 * reads correctly against the numbers on screen.
 *
 * There is no paging anywhere in the storefront, so ordering the whole result in
 * memory is exact. If paging arrives, this has to move into the query.
 */
export function orderForDiscovery<T extends Orderable>(
  products: readonly T[],
  sort: CatalogueSort | null,
  now: Date = new Date()
): T[] {
  const byPrice =
    sort === "price-asc" ? 1 : sort === "price-desc" ? -1 : 0;
  return products
    .map((product, index) => ({
      product,
      index,
      soldOut: stockState(product.stock_quantity).soldOut,
      price: effectivePrice(product, now).price,
    }))
    .sort(
      (a, b) =>
        Number(a.soldOut) - Number(b.soldOut) ||
        byPrice * (a.price - b.price) ||
        a.index - b.index
    )
    .map((row) => row.product);
}

const noun = (n: number) => (n === 1 ? "product" : "products");

/**
 * "30 products", or "8 of 30 products" once a filter has narrowed it.
 *
 * `total` is everything this listing would show unfiltered; `shown` is what is
 * on screen now. Equal means unfiltered, whatever the URL says.
 */
export function resultCountLabel(shown: number, total: number): string {
  return shown === total
    ? `${total} ${noun(total)}`
    : `${shown} of ${total} ${noun(total)}`;
}

/** Ceilings the Price filter may offer. */
export const PRICE_STEPS: readonly number[] = [1500, 2500, 3500, 5000];

/**
 * The price ceilings worth offering for these prices.
 *
 * A ceiling is only useful if it narrows: at least one piece under it AND at
 * least one above. Against today's catalogue "Under ₹3,500" and "Under ₹5,000"
 * both return all 33 products, and on Jewellery every ceiling does — options
 * that change nothing are clutter, and an option that empties the grid reads as
 * broken. Compared on price_inr because that is what the filter compares.
 */
export function usefulPriceSteps(
  prices: readonly number[],
  steps: readonly number[] = PRICE_STEPS
): number[] {
  return steps.filter(
    (step) => prices.some((p) => p <= step) && prices.some((p) => p > step)
  );
}

/**
 * Whether "In stock" is worth offering for these products.
 *
 * Only when it would change something: some pieces sold out AND some not. With
 * everything in stock it is a no-op; with everything sold out it can only ever
 * return an empty grid.
 */
export function offersAvailability(
  products: readonly Pick<ProductListing, "stock_quantity">[]
): boolean {
  const soldOut = products.filter((p) => stockState(p.stock_quantity).soldOut).length;
  return soldOut > 0 && soldOut < products.length;
}

/** A chosen filter, as the chip above the results shows it. */
export type FilterKey = "inStock" | "category" | "size" | "fabric" | "colour" | "maxPrice";
export interface ActiveFilter {
  key: FilterKey;
  label: string;
}

/**
 * The filters a customer has chosen, in the order the panel lists them.
 *
 * Labels are the values as stored and as the panel shows them — nothing is
 * renamed here. A category slug is shown by its name when the page knows it,
 * and as the slug itself when it does not (a shared link to a section that has
 * since emptied), so the chip can still be removed.
 */
export function activeFilters(
  filters: CatalogueFilters,
  categoryName: (slug: string) => string | null = () => null
): ActiveFilter[] {
  const chips: ActiveFilter[] = [];
  if (filters.inStock) chips.push({ key: "inStock", label: "In stock" });
  if (filters.category) {
    chips.push({ key: "category", label: categoryName(filters.category) ?? filters.category });
  }
  if (filters.size) chips.push({ key: "size", label: `Size ${filters.size}` });
  if (filters.fabric) chips.push({ key: "fabric", label: filters.fabric });
  if (filters.colour) chips.push({ key: "colour", label: filters.colour });
  if (filters.maxPrice !== null) {
    chips.push({ key: "maxPrice", label: `Under ${formatINR(filters.maxPrice)}` });
  }
  return chips;
}

/** The same filters with one removed. The sort is kept. */
export function withoutFilter(filters: CatalogueFilters, key: FilterKey): CatalogueFilters {
  return { ...filters, [key]: key === "inStock" ? false : null };
}

/**
 * Every filter cleared, the sort kept: an order is not a filter, and a customer
 * who chose "low to high" and then cleared their filters still wants it.
 */
export function clearedFilters(filters: CatalogueFilters): CatalogueFilters {
  return { ...NO_FILTERS, sort: filters.sort };
}

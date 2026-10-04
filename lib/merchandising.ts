import type { ProductListing } from "./types";
import { stockState } from "./stock";

/**
 * Which pieces the storefront may PROMOTE, as opposed to list.
 *
 * TWO KINDS OF SURFACE, TWO RULES.
 *
 *   * A LISTING — the shop, a category, a collection — is the catalogue, and a
 *     sold-out piece belongs in it. Its page still exists, its URL still works,
 *     and it still says "Sold out". It is moved after everything that can be
 *     bought (orderForDiscovery in lib/catalogueDiscovery), never dropped.
 *   * A PROMOTION — the home page's new-arrivals rail, the personalised rail,
 *     "You May Also Like" — is the shop pointing at something and saying "look
 *     at this". Pointing at a piece nobody can buy is a dead end dressed as an
 *     invitation, so promotions show only what can be bought right now. Fewer
 *     eligible pieces means a shorter row, never padding with sold-out ones.
 *
 * ONE STOCK VERDICT. "Can be bought" is stockState(...).soldOut, the same call
 * the card's "Sold out" label and the listing order already read. The version's
 * stock_quantity is the truth for sized products too: since migration 0056 it is
 * kept equal to the sum of the sizes by trigger, so a product whose every size
 * is gone reads 0 here. Read, never written.
 *
 * PURE: no React, no Next, no database. Tested in
 * scripts/stock-merchandising.test.ts.
 */

type Stocked = Pick<ProductListing, "stock_quantity" | "is_active">;

/** Whether a piece can be added to a cart right now. */
export function isPurchasable(product: Stocked): boolean {
  return product.is_active && !stockState(product.stock_quantity).soldOut;
}

/**
 * The pieces a promotional surface may show, in the order they arrived.
 *
 * ORDER IS PRESERVED, so "newest first" from the query stays newest first —
 * this only removes, it never re-ranks. `limit` caps the row; when fewer pieces
 * qualify the row is simply shorter.
 */
export function promotable<T extends Stocked>(
  products: readonly T[],
  limit: number = Number.POSITIVE_INFINITY
): T[] {
  const out: T[] = [];
  for (const product of products) {
    if (out.length >= limit) break;
    if (isPurchasable(product)) out.push(product);
  }
  return out;
}

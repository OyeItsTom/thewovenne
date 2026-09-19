import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "./supabase";
import type { CartItem } from "./store";
import { getSizesForProducts } from "./sizes";

/**
 * Re-price a cart from the database.
 *
 * The cart arrives from the browser, so every field in it is a claim rather
 * than a fact. Prices are looked up fresh from the published product versions
 * — with any active discount applied by public.effective_price() — and the
 * client's own price_inr is ignored entirely.
 *
 * Without this, the amount charged is whatever the request body says, and a
 * modified request buys a ₹6,000 saree for ₹1.
 *
 * STOCK IS CHECKED HERE TOO, AND THIS IS THE CHECK THAT COUNTS. The product
 * page and the cart cap what they offer, but that is convenience for the
 * customer, not a boundary: the cart lives in localStorage and the request
 * body is typed by whoever sends it. The rule enforced here is that for every
 * sellable unit — a product and a size, or a product with no sizes — the
 * TOTAL asked for across the whole cart fits what is on the shelf now.
 *
 * "Total across the whole cart" is why lines are merged first. The store
 * merges by (id, size) on its own, but nothing obliges a request to have come
 * from the store, and two lines of 2 that each pass a check against a stock
 * of 3 are still 4 pieces nobody has.
 */

export interface PricedItem {
  id: string;
  name: string;
  size: string;
  quantity: number;
  /** Authoritative unit price, from the database. */
  price_inr: number;
  /**
   * What this piece costs US, as at this moment. Snapshotted onto the order so
   * a later change to the product's cost cannot rewrite historical margin.
   * Null when no cost has been recorded — a real absence, not a zero, because
   * zero would read as "free to make" in a P&L.
   */
  cost_price_inr: number | null;
  sku: string | null;
}

/**
 * Why a cart was refused, for a UI that wants to do more than print the
 * sentence. `stock` is the one worth acting on: the basket is real, it just
 * asks for more than is there.
 */
export type PricingRefusal = "empty" | "invalid" | "unavailable" | "stock" | "pricing";

export interface PricingResult {
  items: PricedItem[];
  /** Whole rupees. */
  total: number;
  error: string | null;
  reason: PricingRefusal | null;
}

/** The most of one line anyone can buy in one order, before stock is asked. */
export const MAX_LINE_QUANTITY = 99;

export async function priceCart(
  items: CartItem[],
  client: SupabaseClient = createServiceClient()
): Promise<PricingResult> {
  const empty = { items: [], total: 0 };
  const refuse = (reason: PricingRefusal, error: string): PricingResult => ({
    ...empty,
    error,
    reason,
  });

  if (!Array.isArray(items) || items.length === 0) {
    return refuse("empty", "Your cart is empty.");
  }

  // Quantities are the customer's to choose, but they still have to be sane.
  // Checked per line BEFORE merging so a malformed line cannot hide inside a
  // sum — two lines of 0.5 do not make one valid line of 1.
  for (const item of items) {
    if (
      !item?.id ||
      typeof item.id !== "string" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_LINE_QUANTITY
    ) {
      return refuse("invalid", "That cart isn't valid — please try again.");
    }
  }

  const ids = [...new Set(items.map((i) => i.id))];
  const supabase = client;
  const [{ data, error }, sizeMap, { data: versionRows, error: versionError }] =
    await Promise.all([
      supabase.rpc("checkout_prices", { p_ids: ids }),
      getSizesForProducts(ids, supabase),
      // The count a sale of an UNSIZED product decrements — reserve_stock
      // reads exactly this row (0038). checkout_prices only says whether it is
      // above zero, which cannot tell "three asked, two left" from "in stock".
      supabase
        .from("product_versions")
        .select("product_id, stock_quantity")
        .eq("state", "published")
        .in("product_id", ids),
    ]);

  if (error || versionError) {
    console.error("priceCart:", (error ?? versionError)?.message);
    return refuse("pricing", "Could not price your order. Please try again.");
  }

  const priced = new Map(
    (
      (data ?? []) as {
        product_id: string;
        name: string;
        price_inr: number;
        cost_price_inr: number | null;
        sku: string | null;
        in_stock: boolean;
      }[]
    ).map((r) => [r.product_id, r])
  );

  const publishedStock = new Map(
    ((versionRows ?? []) as { product_id: string; stock_quantity: number | null }[]).map(
      (r) => [r.product_id, Number(r.stock_quantity ?? 0)]
    )
  );

  // ── Merge to sellable units ──
  // One entry per thing that can run out: (product, size label) where the
  // product has sizes, or the product alone where it has none. Insertion
  // order is kept so the order's lines read in the order the customer
  // built the cart. The size label is matched exactly as stored — the same
  // rule reserve_stock applies — after trimming what the browser sent.
  interface Unit {
    id: string;
    name: string;
    size: string;
    sized: boolean;
    quantity: number;
    available: number;
    row: NonNullable<ReturnType<typeof priced.get>>;
  }
  const units = new Map<string, Unit>();

  for (const item of items) {
    const row = priced.get(item.id);
    // Unknown, unpublished or deactivated products get no row. Refusing is the
    // only safe response — there is no price to fall back to.
    if (!row) {
      return refuse(
        "unavailable",
        "Something in your cart is no longer available. Please remove it and try again."
      );
    }

    const sizes = sizeMap.get(item.id) ?? [];
    const asked = typeof item.size === "string" ? item.size.trim().slice(0, 40) : "";

    let key: string;
    let size: string;
    let available: number;
    if (sizes.length > 0) {
      // A product with sizes is in stock per SIZE — the product-level flag
      // says nothing about the one this customer picked.
      const chosen = sizes.find((s) => s.label === asked);
      if (!chosen) {
        return refuse("invalid", `Please choose a size for ${row.name}.`);
      }
      key = `${item.id}\u0000${chosen.label}`;
      size = chosen.label;
      available = chosen.stock_quantity;
    } else {
      key = item.id;
      size = "One Size";
      // Belt and braces: the boolean is what checkout_prices has always
      // returned, and a version row that somehow did not come back must read
      // as nothing on the shelf rather than plenty.
      available = row.in_stock ? (publishedStock.get(item.id) ?? 0) : 0;
    }

    const existing = units.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      units.set(key, {
        id: item.id,
        name: row.name,
        size,
        sized: sizes.length > 0,
        quantity: item.quantity,
        available,
        row,
      });
    }
  }

  // ── Stock, against the merged demand ──
  const out: PricedItem[] = [];
  for (const unit of units.values()) {
    // The per-line ceiling applies to the merged line too. Splitting 99 into
    // 50 + 49 is still one line of 99, and 60 + 60 is not a way past it.
    if (unit.quantity > MAX_LINE_QUANTITY) {
      return refuse("invalid", "That cart isn't valid — please try again.");
    }

    if (unit.available < unit.quantity) {
      const where = unit.sized ? ` in ${unit.size}` : "";
      return refuse(
        "stock",
        unit.available === 0
          ? `${unit.name}${where} has just sold out.`
          : `Only ${unit.available} left of ${unit.name}${where}.`
      );
    }

    out.push({
      id: unit.id,
      name: unit.name,
      size: unit.size,
      quantity: unit.quantity,
      price_inr: Number(unit.row.price_inr),
      // Null stays null. Coercing an unrecorded cost to 0 would report a 100%
      // margin on a piece nobody has costed, which is worse than reporting none.
      cost_price_inr:
        unit.row.cost_price_inr === null || unit.row.cost_price_inr === undefined
          ? null
          : Number(unit.row.cost_price_inr),
      sku: unit.row.sku ?? null,
    });
  }

  return {
    items: out,
    total: out.reduce((sum, i) => sum + i.price_inr * i.quantity, 0),
    error: null,
    reason: null,
  };
}

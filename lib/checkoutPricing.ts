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
 */

export interface PricedItem {
  id: string;
  name: string;
  size: string;
  quantity: number;
  /** Authoritative unit price, from the database. */
  price_inr: number;
}

export interface PricingResult {
  items: PricedItem[];
  /** Whole rupees. */
  total: number;
  error: string | null;
}

export async function priceCart(items: CartItem[]): Promise<PricingResult> {
  const empty = { items: [], total: 0 };

  if (!Array.isArray(items) || items.length === 0) {
    return { ...empty, error: "Your cart is empty." };
  }

  // Quantities are the customer's to choose, but they still have to be sane.
  for (const item of items) {
    if (
      !item?.id ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99
    ) {
      return { ...empty, error: "That cart isn't valid — please try again." };
    }
  }

  const ids = [...new Set(items.map((i) => i.id))];
  const supabase = createServiceClient();
  const [{ data, error }, sizeMap] = await Promise.all([
    supabase.rpc("checkout_prices", { p_ids: ids }),
    getSizesForProducts(ids, supabase),
  ]);

  if (error) {
    console.error("priceCart:", error.message);
    return { ...empty, error: "Could not price your order. Please try again." };
  }

  const priced = new Map(
    (
      (data ?? []) as {
        product_id: string;
        name: string;
        price_inr: number;
        in_stock: boolean;
      }[]
    ).map((r) => [r.product_id, r])
  );

  const out: PricedItem[] = [];
  for (const item of items) {
    const row = priced.get(item.id);
    // Unknown, unpublished or deactivated products get no row. Refusing is the
    // only safe response — there is no price to fall back to.
    if (!row) {
      return {
        ...empty,
        error:
          "Something in your cart is no longer available. Please remove it and try again.",
      };
    }
    // A product with sizes is in stock per SIZE — the product-level flag says
    // nothing about the one this customer picked.
    const sizes = sizeMap.get(item.id) ?? [];
    if (sizes.length > 0) {
      const chosen = sizes.find((s) => s.label === item.size);
      if (!chosen) {
        return {
          ...empty,
          error: `Please choose a size for ${row.name}.`,
        };
      }
      if (chosen.stock_quantity < item.quantity) {
        return {
          ...empty,
          error:
            chosen.stock_quantity === 0
              ? `${row.name} in ${chosen.label} has just sold out.`
              : `Only ${chosen.stock_quantity} left of ${row.name} in ${chosen.label}.`,
        };
      }
    } else if (!row.in_stock) {
      return { ...empty, error: `${row.name} has just sold out.` };
    }
    out.push({
      id: item.id,
      name: row.name,
      size: typeof item.size === "string" ? item.size.slice(0, 40) : "One Size",
      quantity: item.quantity,
      price_inr: Number(row.price_inr),
    });
  }

  return {
    items: out,
    total: out.reduce((sum, i) => sum + i.price_inr * i.quantity, 0),
    error: null,
  };
}

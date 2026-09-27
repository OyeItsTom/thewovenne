import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { sizeChanges, stockErrorMessage, type LoadedSize } from "./inventory";

/**
 * Per-product sizes and their stock.
 *
 * Outside the draft/publish system on purpose — see migration 0021. Stock is
 * operational, not editorial: a purchase cannot wait for a Publish, so these
 * reads and writes are always against live data.
 */

export interface ProductSize {
  id: string;
  label: string;
  sort_order: number;
  stock_quantity: number;
}

/** A product's sizes, in display order. Empty means single-stock (e.g. sarees). */
export async function getProductSizes(
  productId: string,
  client: SupabaseClient = supabase
): Promise<ProductSize[]> {
  const { data, error } = await client
    .from("product_sizes")
    .select("id, label, sort_order, stock_quantity")
    .eq("product_id", productId)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getProductSizes:", error.message);
    return [];
  }
  return (data as ProductSize[]) ?? [];
}

/** Sizes for many products at once, for listings and filters. */
export async function getSizesForProducts(
  productIds: string[],
  client: SupabaseClient = supabase
): Promise<Map<string, ProductSize[]>> {
  const out = new Map<string, ProductSize[]>();
  if (productIds.length === 0) return out;

  const { data, error } = await client
    .from("product_sizes")
    .select("id, product_id, label, sort_order, stock_quantity")
    .in("product_id", productIds)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getSizesForProducts:", error.message);
    return out;
  }

  for (const row of (data ?? []) as (ProductSize & { product_id: string })[]) {
    const list = out.get(row.product_id) ?? [];
    list.push(row);
    out.set(row.product_id, list);
  }
  return out;
}

/**
 * Whether a product can be bought at all.
 *
 * With sizes, "in stock" means at least one size has stock — a product whose
 * every size is sold out is sold out, however healthy its old single count is.
 */
export function hasAnyStock(
  sizes: ProductSize[],
  fallbackStock: number
): boolean {
  if (sizes.length === 0) return fallbackStock > 0;
  return sizes.some((s) => s.stock_quantity > 0);
}

/** Suggested starting set when an admin adds sizes to a new product. */
export const DEFAULT_SIZE_RUN = ["S", "M", "L", "XL"];

export interface SizeDraft {
  /** Present for a row that already exists; absent for a newly added one. */
  id?: string;
  label: string;
  stock_quantity: number;
}

/**
 * Save what the admin changed about a product's sizes.
 *
 * Writes immediately — these rows are outside draft/publish, because stock
 * cannot wait for a Publish. `loaded` is what the form showed when it opened:
 * each size goes out with the count the admin saw, and the database refuses the
 * whole save if any count the admin CHANGED has moved on the shelf since
 * (migration 0060). A count the admin did not touch is never written back, so
 * an open form cannot restock a size that sold while it was open.
 *
 * Nothing changed → no call at all. Returns an error message, or null.
 */
export async function saveProductSizes(
  client: SupabaseClient,
  productId: string,
  loaded: LoadedSize[],
  sizes: SizeDraft[]
): Promise<string | null> {
  let changes;
  try {
    changes = sizeChanges(loaded, sizes);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (changes.length === 0) return null;

  // One database call, in one transaction: only the database can see what the
  // stock IS, and a save is either applied whole or refused whole.
  const { error } = await client.rpc("save_product_sizes", {
    p_product_id: productId,
    p_sizes: changes,
    p_request_id: crypto.randomUUID(),
  });

  return error ? stockErrorMessage(error.message).message : null;
}

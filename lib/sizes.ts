import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";

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
 * Replace a product's sizes with `sizes`, in order.
 *
 * Writes immediately — these rows are outside draft/publish, because stock
 * cannot wait for a Publish. Delete-then-upsert rather than diffing: the row
 * count is tiny and this cannot leave a stale size behind.
 *
 * Returns an error message, or null on success.
 */
export async function saveProductSizes(
  client: SupabaseClient,
  productId: string,
  sizes: SizeDraft[]
): Promise<string | null> {
  const clean = sizes
    .map((s) => ({
      label: s.label.trim(),
      stock_quantity: Math.max(0, Math.floor(Number(s.stock_quantity) || 0)),
    }))
    .filter((s) => s.label.length > 0);

  // Duplicate labels would violate the unique index and lose a row silently.
  const seen = new Set<string>();
  for (const s of clean) {
    const key = s.label.toLowerCase();
    if (seen.has(key)) return `"${s.label}" is listed twice.`;
    seen.add(key);
  }

  const { error: deleteError } = await client
    .from("product_sizes")
    .delete()
    .eq("product_id", productId);
  if (deleteError) return deleteError.message;

  if (clean.length === 0) return null;

  const { error: insertError } = await client.from("product_sizes").insert(
    clean.map((s, i) => ({
      product_id: productId,
      label: s.label,
      sort_order: i,
      stock_quantity: s.stock_quantity,
    }))
  );
  return insertError?.message ?? null;
}

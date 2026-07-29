import { supabase } from "./supabase";
import { getVisibleCategoryIds } from "./categories";
import type { Product } from "./types";

// Products join their category so callers get the category *name* for display
// (product.category) alongside the relational category_id used for filtering.
const PRODUCT_SELECT = "*, categories(name, slug)";

type ProductRow = Omit<Product, "category" | "category_slug"> & {
  categories: { name: string; slug: string } | null;
};

/** Flatten the joined categories row into product.category / category_slug. */
function mapProduct(row: ProductRow): Product {
  const { categories, ...rest } = row;
  return {
    ...rest,
    category: categories?.name ?? null,
    category_slug: categories?.slug ?? null,
  };
}

/**
 * Every public query below is scoped to categories a shopper may see, so
 * hiding a category hides its products too — not just its filter chip.
 *
 * Note this also excludes products with no category at all: an uncategorised
 * product has not been placed anywhere, so it stays off the storefront until
 * it is filed. Admin queries don't go through this module and are unaffected.
 */
async function scopeToVisible(categoryIds?: string[]): Promise<string[]> {
  const visible = await getVisibleCategoryIds();
  if (!categoryIds) return visible;

  const allowed = new Set(visible);
  return categoryIds.filter((id) => allowed.has(id));
}

export async function getFeaturedProducts(limit = 4): Promise<Product[]> {
  const visibleIds = await scopeToVisible();
  if (visibleIds.length === 0) return [];

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
    .in("category_id", visibleIds)
    .gt("stock_quantity", 0)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getFeaturedProducts:", error.message);
    return [];
  }
  return (data as ProductRow[] | null)?.map(mapProduct) ?? [];
}

export async function getAllProducts(): Promise<Product[]> {
  const visibleIds = await scopeToVisible();
  if (visibleIds.length === 0) return [];

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
    .in("category_id", visibleIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAllProducts:", error.message);
    return [];
  }
  return (data as ProductRow[] | null)?.map(mapProduct) ?? [];
}

/**
 * Active products across a set of categories — used by the /men and /women
 * landing pages, which pass in their visible sub-category ids.
 */
export async function getProductsByCategoryIds(
  categoryIds: string[]
): Promise<Product[]> {
  if (categoryIds.length === 0) return [];

  const scoped = await scopeToVisible(categoryIds);
  if (scoped.length === 0) return [];

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
    .in("category_id", scoped)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getProductsByCategoryIds:", error.message);
    return [];
  }
  return (data as ProductRow[] | null)?.map(mapProduct) ?? [];
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const visibleIds = await scopeToVisible();
  if (visibleIds.length === 0) return null;

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("slug", slug)
    .eq("is_active", true)
    .in("category_id", visibleIds)
    .maybeSingle();

  if (error) {
    console.error("getProductBySlug:", error.message);
    return null;
  }
  return data ? mapProduct(data as ProductRow) : null;
}

export async function getRelatedProducts(
  categoryId: string | null,
  excludeSlug: string,
  limit = 4
): Promise<Product[]> {
  if (!categoryId) return [];

  const scoped = await scopeToVisible([categoryId]);
  if (scoped.length === 0) return [];

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
    .eq("category_id", categoryId)
    .neq("slug", excludeSlug)
    .limit(limit);

  if (error) {
    console.error("getRelatedProducts:", error.message);
    return [];
  }
  return (data as ProductRow[] | null)?.map(mapProduct) ?? [];
}

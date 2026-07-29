import { supabase } from "./supabase";
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

export async function getFeaturedProducts(limit = 4): Promise<Product[]> {
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
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
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAllProducts:", error.message);
    return [];
  }
  return (data as ProductRow[] | null)?.map(mapProduct) ?? [];
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("slug", slug)
    .eq("is_active", true)
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

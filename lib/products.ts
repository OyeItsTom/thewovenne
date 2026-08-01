import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { getAllCategories, getVisibleCategoryIds } from "./categories";
import type { Category, Product } from "./types";

// Storefront reads come from PUBLISHED versions, never the identity tables.
// RLS only exposes state = 'published' to anon, so a mistake here cannot leak
// draft work — the policy is the guarantee, this is just the query.
const PRODUCT_SELECT =
  "product_id, name, slug, description, price_inr, category_id, fabric, colour, " +
  "stock_quantity, image_url, is_active, created_at, collection, " +
  "discount_type, discount_value, discount_starts_at, discount_ends_at";

type ProductVersionRow = {
  product_id: string;
  name: string;
  slug: string;
  description: string | null;
  price_inr: number;
  category_id: string | null;
  fabric: string | null;
  colour: string | null;
  stock_quantity: number;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  collection: string | null;
  discount_type: "percent" | "flat" | null;
  discount_value: number | null;
  discount_starts_at: string | null;
  discount_ends_at: string | null;
};

/**
 * Flatten a version row to the Product shape callers expect: the stable
 * product id, plus the category NAME resolved from the published category
 * versions rather than joined.
 *
 * Resolved from a map rather than a PostgREST embed because the name lives on
 * category_versions, not the categories identity row — embedding would give
 * whatever the identity table happens to hold.
 */
function mapProduct(row: ProductVersionRow, categories: Map<string, Category>): Product {
  const category = row.category_id ? categories.get(row.category_id) : undefined;
  return {
    id: row.product_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    price_inr: row.price_inr,
    category_id: row.category_id,
    fabric: row.fabric,
    colour: row.colour,
    stock_quantity: row.stock_quantity,
    image_url: row.image_url,
    is_active: row.is_active,
    created_at: row.created_at,
    category: category?.name ?? null,
    category_slug: category?.slug ?? null,
    collection: row.collection,
    discount_type: row.discount_type,
    discount_value: row.discount_value,
    discount_starts_at: row.discount_starts_at,
    discount_ends_at: row.discount_ends_at,
  };
}

/** category id -> published category, for resolving display names. */
async function categoryMap(client: SupabaseClient = supabase) {
  const all = await getAllCategories(client);
  return new Map(all.map((c) => [c.id, c]));
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

/**
 * A product's gallery, in order. Returns [] rather than throwing if the
 * product_images table isn't there yet, so the product page falls back to the
 * single image_url instead of the whole route erroring.
 */
export async function getProductImages(
  productId: string,
  client: SupabaseClient = supabase
): Promise<string[]> {
  // Galleries hang off the version, so read the published version's images.
  const { data, error } = await client
    .from("product_images")
    .select("url, product_versions!inner(product_id, state)")
    .eq("product_versions.product_id", productId)
    .eq("product_versions.state", "published")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getProductImages:", error.message);
    return [];
  }
  return (data ?? []).map((row) => row.url as string);
}

/**
 * Every product, including inactive ones and those in hidden categories, with
 * category names resolved. For the admin table only — deliberately skips the
 * visibility scoping above, since the whole point of the dashboard is to see
 * and manage what the storefront hides. RLS still gates it: the "Admins can
 * view all products" policy requires is_admin().
 */
export async function getAdminProducts(
  client: SupabaseClient = supabase
): Promise<Product[]> {
  const cats = await categoryMap(client);
  const { data, error } = await client
    .from("product_versions")
    .select(`${PRODUCT_SELECT}, state, pending_delete`)
    .in("state", ["published", "draft"])
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAdminProducts:", error.message);
    return [];
  }

  // A draft supersedes the published version of the same product, so the admin
  // always sees what it will look like once published.
  const rows =
    (data as unknown as (ProductVersionRow & { state: string; pending_delete: boolean })[]) ?? [];
  const byProduct = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = byProduct.get(row.product_id);
    if (!seen || row.state === "draft") byProduct.set(row.product_id, row);
  }

  // A product whose only draft deletes it is still live, so it stays listed —
  // marked, not hidden. Hiding it would make the pending deletion invisible.
  return [...byProduct.values()].map((r) => mapProduct(r, cats));
}

/** Product ids with unpublished changes — for "not yet live" markers. */
export async function getDraftProductIds(
  client: SupabaseClient = supabase
): Promise<Set<string>> {
  const { data } = await client
    .from("product_versions")
    .select("product_id")
    .eq("state", "draft");
  return new Set((data ?? []).map((r) => r.product_id as string));
}

/**
 * The draft version's gallery, for the admin editor. Falls back to the
 * published gallery when no draft exists yet.
 */
export async function getDraftProductImages(
  productId: string,
  client: SupabaseClient = supabase
): Promise<string[]> {
  const { data, error } = await client
    .from("product_images")
    .select("url, sort_order, product_versions!inner(product_id, state)")
    .eq("product_versions.product_id", productId)
    .in("product_versions.state", ["draft", "published"])
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getDraftProductImages:", error.message);
    return [];
  }
  const rows = (data ?? []) as unknown as {
    url: string;
    product_versions: { state: string };
  }[];
  const draft = rows.filter((r) => r.product_versions.state === "draft");
  return (draft.length ? draft : rows).map((r) => r.url);
}

export async function getFeaturedProducts(limit = 4): Promise<Product[]> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(), categoryMap()]);
  if (visibleIds.length === 0) return [];

  const { data, error } = await supabase
    .from("product_versions")
    .select(PRODUCT_SELECT)
    .eq("state", "published")
    .eq("is_active", true)
    .in("category_id", visibleIds)
    .gt("stock_quantity", 0)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getFeaturedProducts:", error.message);
    return [];
  }
  return ((data as unknown as ProductVersionRow[] | null) ?? []).map((r) => mapProduct(r, cats));
}

export async function getAllProducts(): Promise<Product[]> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(), categoryMap()]);
  if (visibleIds.length === 0) return [];

  const { data, error } = await supabase
    .from("product_versions")
    .select(PRODUCT_SELECT)
    .eq("state", "published")
    .eq("is_active", true)
    .in("category_id", visibleIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAllProducts:", error.message);
    return [];
  }
  return ((data as unknown as ProductVersionRow[] | null) ?? []).map((r) => mapProduct(r, cats));
}

/**
 * Products in a seasonal collection, e.g. "onam-edit".
 *
 * Goes through scopeToVisible like every other listing, so putting a product
 * from a hidden category into a campaign does not become a way around the
 * visibility rules.
 */
export async function getProductsByCollection(
  collection: string
): Promise<Product[]> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(), categoryMap()]);
  if (visibleIds.length === 0) return [];

  const { data, error } = await supabase
    .from("product_versions")
    .select(PRODUCT_SELECT)
    .eq("state", "published")
    .eq("is_active", true)
    .eq("collection", collection)
    .in("category_id", visibleIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getProductsByCollection:", error.message);
    return [];
  }
  return ((data as unknown as ProductVersionRow[] | null) ?? []).map((r) => mapProduct(r, cats));
}

/** Distinct published collection slugs, for generateStaticParams. */
export async function getCollectionSlugs(): Promise<string[]> {
  const { data, error } = await supabase
    .from("product_versions")
    .select("collection")
    .eq("state", "published")
    .eq("is_active", true)
    .not("collection", "is", null);

  if (error) {
    console.error("getCollectionSlugs:", error.message);
    return [];
  }
  return [
    ...new Set(
      (data ?? [])
        .map((r) => (r as { collection: string | null }).collection)
        .filter((c): c is string => !!c)
    ),
  ];
}

/**
 * Active products across a set of categories — used by the /men and /women
 * landing pages, which pass in their visible sub-category ids.
 */
export async function getProductsByCategoryIds(
  categoryIds: string[]
): Promise<Product[]> {
  if (categoryIds.length === 0) return [];

  const [scoped, cats] = await Promise.all([scopeToVisible(categoryIds), categoryMap()]);
  if (scoped.length === 0) return [];

  const { data, error } = await supabase
    .from("product_versions")
    .select(PRODUCT_SELECT)
    .eq("state", "published")
    .eq("is_active", true)
    .in("category_id", scoped)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getProductsByCategoryIds:", error.message);
    return [];
  }
  return ((data as unknown as ProductVersionRow[] | null) ?? []).map((r) => mapProduct(r, cats));
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const [visibleIds, cats] = await Promise.all([scopeToVisible(), categoryMap()]);
  if (visibleIds.length === 0) return null;

  const { data, error } = await supabase
    .from("product_versions")
    .select(PRODUCT_SELECT)
    .eq("state", "published")
    .eq("slug", slug)
    .eq("is_active", true)
    .in("category_id", visibleIds)
    .maybeSingle();

  if (error) {
    console.error("getProductBySlug:", error.message);
    return null;
  }
  return data ? mapProduct(data as unknown as ProductVersionRow, cats) : null;
}

export async function getRelatedProducts(
  categoryId: string | null,
  excludeSlug: string,
  limit = 4
): Promise<Product[]> {
  if (!categoryId) return [];

  const [scoped, cats] = await Promise.all([scopeToVisible([categoryId]), categoryMap()]);
  if (scoped.length === 0) return [];

  const { data, error } = await supabase
    .from("product_versions")
    .select(PRODUCT_SELECT)
    .eq("state", "published")
    .eq("is_active", true)
    .eq("category_id", categoryId)
    .neq("slug", excludeSlug)
    .limit(limit);

  if (error) {
    console.error("getRelatedProducts:", error.message);
    return [];
  }
  return ((data as unknown as ProductVersionRow[] | null) ?? []).map((r) => mapProduct(r, cats));
}

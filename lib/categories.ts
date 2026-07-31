import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Category, CategoryNode } from "./types";

/** A category_versions row, flattened to the Category shape callers expect. */
type CategoryVersionRow = {
  category_id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  is_visible: boolean;
  sort_order: number;
  created_at: string;
};

/**
 * Version rows carry their own id; callers want the stable category id, since
 * that is what products reference and what the admin acts on.
 */
function mapCategoryVersion(row: CategoryVersionRow): Category {
  return {
    id: row.category_id,
    name: row.name,
    slug: row.slug,
    parent_id: row.parent_id,
    is_visible: row.is_visible,
    sort_order: row.sort_order,
    created_at: row.created_at,
  };
}

/**
 * All categories, unfiltered — for the admin Category manager (which needs to
 * see hidden ones too). Ordered parent-friendly by sort_order.
 *
 * Reads PUBLISHED versions. RLS only exposes state = 'published' to anon, so
 * unpublished work cannot leak here even if this query were wrong.
 *
 * Pass the authenticated browser client from admin screens: the default anon
 * client only satisfies the published policy, so hidden rows would silently be
 * missing.
 */
export async function getAllCategories(
  client: SupabaseClient = supabase
): Promise<Category[]> {
  const { data, error } = await client
    .from("category_versions")
    .select("category_id, name, slug, parent_id, is_visible, sort_order, created_at")
    .eq("state", "published")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getAllCategories:", error.message);
    return [];
  }
  return ((data as CategoryVersionRow[] | null) ?? []).map(mapCategoryVersion);
}

/**
 * The visible category tree for storefront nav / shop filters.
 *
 * Visibility rules:
 *  - Only visible parents are walked, so a hidden parent hides its whole
 *    section even if individual children are marked visible.
 *  - Within a visible parent, only visible children are included.
 *  - Parents with no visible children are dropped (no empty sections).
 */
export async function getVisibleCategoryTree(): Promise<CategoryNode[]> {
  const all = await getAllCategories();

  return all
    .filter((c) => c.parent_id === null && c.is_visible)
    .map((parent) => ({
      ...parent,
      children: all.filter((c) => c.parent_id === parent.id && c.is_visible),
    }))
    .filter((parent) => parent.children.length > 0);
}

/**
 * Ids of every category a shopper is allowed to see: visible parents, plus
 * visible children of visible parents. A hidden parent hides its children even
 * when they are individually visible — the same rule the nav and shop filters
 * apply, kept here so product queries can't drift from it.
 *
 * Unlike getVisibleCategoryTree this keeps parents that have no visible
 * children, since a product can be filed directly against a parent.
 */
export async function getVisibleCategoryIds(): Promise<string[]> {
  const all = await getAllCategories();

  const visibleParents = new Set(
    all.filter((c) => c.parent_id === null && c.is_visible).map((c) => c.id)
  );

  return all
    .filter((c) =>
      c.parent_id === null
        ? c.is_visible
        : c.is_visible && visibleParents.has(c.parent_id)
    )
    .map((c) => c.id);
}

/**
 * The nav-ready tree: the visible tree, narrowed to parents that have at least
 * one visible sub-category actually holding an active product. Keeps "Men" and
 * "Women" out of the nav until there is something to sell under them, and stays
 * in sync with whatever admin has configured.
 *
 * Stock level is deliberately ignored — an in-stock check would pull a whole
 * section out of the nav the moment its last item sold out.
 */
export async function getNavCategoryTree(): Promise<CategoryNode[]> {
  const tree = await getVisibleCategoryTree();
  if (tree.length === 0) return [];

  const { data, error } = await supabase
    .from("products")
    .select("category_id")
    .eq("is_active", true);

  // Fail closed: if we can't confirm a section has products, don't advertise it.
  if (error) {
    console.error("getNavCategoryTree:", error.message);
    return [];
  }

  const stocked = new Set(
    (data ?? []).map((row) => row.category_id).filter(Boolean) as string[]
  );

  return tree
    .map((parent) => ({
      ...parent,
      children: parent.children.filter((child) => stocked.has(child.id)),
    }))
    .filter((parent) => parent.children.length > 0);
}

import { supabase } from "./supabase";
import type { Category, CategoryNode } from "./types";

/**
 * All categories, unfiltered — for the admin Category manager (which needs to
 * see hidden ones too). Ordered parent-friendly by sort_order.
 */
export async function getAllCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getAllCategories:", error.message);
    return [];
  }
  return (data as Category[] | null) ?? [];
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

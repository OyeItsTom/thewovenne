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

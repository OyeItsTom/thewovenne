import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Category, CategoryNode } from "./types";
import { ANON_CTX, statesFor, type ReadCtx } from "./readCtx";

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
  client?: SupabaseClient,
  { drafts }: { drafts?: boolean } = {}
): Promise<Category[]> {
  // Storefront callers pass nothing, so preview flows through here without
  // every page having to know about it. Admin screens pass both explicitly and
  // are unaffected.
  const read = client ?? supabase;
  const withDrafts = drafts ?? false;
  const { data, error } = await read
    .from("category_versions")
    .select("category_id, state, name, slug, parent_id, is_visible, sort_order, created_at")
    .in("state", withDrafts ? ["published", "draft"] : ["published"])
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getAllCategories:", error.message);
    return [];
  }

  const rows = (data as (CategoryVersionRow & { state: string })[] | null) ?? [];
  if (!withDrafts) return rows.map(mapCategoryVersion);

  // Admin view: a draft supersedes the published version of the same category.
  const byCategory = new Map<string, CategoryVersionRow & { state: string }>();
  for (const row of rows) {
    const seen = byCategory.get(row.category_id);
    if (!seen || row.state === "draft") byCategory.set(row.category_id, row);
  }
  return [...byCategory.values()]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(mapCategoryVersion);
}

/** Category ids with unpublished changes — for "not yet live" markers. */
export async function getDraftCategoryIds(
  client: SupabaseClient = supabase
): Promise<Set<string>> {
  const { data } = await client
    .from("category_versions")
    .select("category_id")
    .eq("state", "draft");
  return new Set((data ?? []).map((r) => r.category_id as string));
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
export async function getVisibleCategoryTree(
  ctx: ReadCtx = ANON_CTX
): Promise<CategoryNode[]> {
  const all = await getAllCategories(ctx.client, { drafts: ctx.preview });

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
export async function getVisibleCategoryIds(
  ctx: ReadCtx = ANON_CTX
): Promise<string[]> {
  const all = await getAllCategories(ctx.client, { drafts: ctx.preview });

  return visibleCategoryIds(all);
}

/** Pure visibility rule shared with catalogue reads that already fetched categories. */
export function visibleCategoryIds(all: Category[]): string[] {
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
export async function getNavCategoryTree(
  ctx: ReadCtx = ANON_CTX
): Promise<CategoryNode[]> {
  const tree = await getVisibleCategoryTree(ctx);
  if (tree.length === 0) return [];

  const { data, error } = await ctx.client
    .from("product_versions")
    .select("category_id")
    .in("state", statesFor(ctx))
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

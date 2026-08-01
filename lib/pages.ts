import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { ANON_CTX, preferDraft, statesFor, type ReadCtx } from "./readCtx";

/**
 * Content pages — About, Size Guide, Policies, Contact, FAQ and anything added
 * later. They are rows, not routes, so copy and images change without a code
 * change or a deploy.
 */

export type PageBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "image"; url: string; alt?: string }
  | { type: "faq"; question: string; answer: string };

export interface SitePage {
  /** Stable page id — what the admin acts on. */
  id: string;
  slug: string;
  title: string;
  intro: string | null;
  body: PageBlock[];
  in_footer: boolean;
  sort_order: number;
  meta_description: string | null;
}

const PAGE_SELECT =
  "page_id, slug, title, intro, body, in_footer, sort_order, meta_description";

type PageVersionRow = Omit<SitePage, "id" | "body"> & {
  page_id: string;
  body: unknown;
};

function mapPage(row: PageVersionRow): SitePage {
  return {
    id: row.page_id,
    slug: row.slug,
    title: row.title,
    intro: row.intro,
    // Body is jsonb; anything unexpected renders as nothing rather than
    // throwing and taking the page down.
    body: Array.isArray(row.body) ? (row.body as PageBlock[]) : [],
    in_footer: row.in_footer,
    sort_order: row.sort_order,
    meta_description: row.meta_description,
  };
}

/** Published pages, for the storefront and the footer. */
export async function getPublishedPages(
  ctx: ReadCtx = ANON_CTX
): Promise<SitePage[]> {
  const preview = ctx.preview;
  const { data, error } = await ctx.client
    .from("site_page_versions")
    .select(preview ? `${PAGE_SELECT}, state, pending_delete` : PAGE_SELECT)
    .in("state", statesFor(ctx))
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getPublishedPages:", error.message);
    return [];
  }
  const rows = (data as unknown as (PageVersionRow & {
    state?: string;
    pending_delete?: boolean;
  })[] | null) ?? [];
  return preferDraft(rows, (r) => r.page_id).map(mapPage);
}

export async function getPageBySlug(
  slug: string,
  ctx: ReadCtx = ANON_CTX
): Promise<SitePage | null> {
  const preview = ctx.preview;
  const { data, error } = await ctx.client
    .from("site_page_versions")
    .select(preview ? `${PAGE_SELECT}, state, pending_delete` : PAGE_SELECT)
    .in("state", statesFor(ctx))
    .eq("slug", slug);

  if (error) {
    console.error("getPageBySlug:", error.message);
    return null;
  }
  // Not maybeSingle(): in preview a page with a draft matches twice.
  const rows = (data as unknown as (PageVersionRow & {
    state?: string;
    pending_delete?: boolean;
  })[] | null) ?? [];
  const one = preferDraft(rows, (r) => r.page_id)[0];
  return one ? mapPage(one) : null;
}

/** Admin list: drafts supersede their published counterparts. */
export async function getAdminPages(
  client: SupabaseClient = supabase
): Promise<SitePage[]> {
  const { data, error } = await client
    .from("site_page_versions")
    .select(`${PAGE_SELECT}, state`)
    .in("state", ["published", "draft"])
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getAdminPages:", error.message);
    return [];
  }

  const rows = (data as unknown as (PageVersionRow & { state: string })[]) ?? [];
  const byPage = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = byPage.get(row.page_id);
    if (!seen || row.state === "draft") byPage.set(row.page_id, row);
  }
  return [...byPage.values()].map(mapPage);
}

/** Page ids with unpublished changes. */
export async function getDraftPageIds(
  client: SupabaseClient = supabase
): Promise<Set<string>> {
  const { data } = await client
    .from("site_page_versions")
    .select("page_id")
    .eq("state", "draft");
  return new Set((data ?? []).map((r) => r.page_id as string));
}

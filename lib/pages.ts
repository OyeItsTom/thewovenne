import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";

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
export async function getPublishedPages(): Promise<SitePage[]> {
  const { data, error } = await supabase
    .from("site_page_versions")
    .select(PAGE_SELECT)
    .eq("state", "published")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("getPublishedPages:", error.message);
    return [];
  }
  return ((data as unknown as PageVersionRow[] | null) ?? []).map(mapPage);
}

export async function getPageBySlug(slug: string): Promise<SitePage | null> {
  const { data, error } = await supabase
    .from("site_page_versions")
    .select(PAGE_SELECT)
    .eq("state", "published")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    console.error("getPageBySlug:", error.message);
    return null;
  }
  return data ? mapPage(data as unknown as PageVersionRow) : null;
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

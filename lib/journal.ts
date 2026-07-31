import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { JournalPost } from "./types";

/**
 * Journal reads come from PUBLISHED versions. Two different "published" are in
 * play and both must hold: the VERSION must be published (the edit has been
 * released) and the POST's own published flag must be true (it isn't a
 * work-in-progress article). A post can be a published version that is still an
 * unpublished post.
 */
const JOURNAL_SELECT = "journal_id, title, slug, body, image_url, published, created_at";

type JournalVersionRow = {
  journal_id: string;
  title: string;
  slug: string;
  body: string | null;
  image_url: string | null;
  published: boolean;
  created_at: string;
};

function mapPost(row: JournalVersionRow): JournalPost {
  return {
    id: row.journal_id,
    title: row.title,
    slug: row.slug,
    body: row.body,
    image_url: row.image_url,
    published: row.published,
    created_at: row.created_at,
  };
}

/** Published journal posts, newest first. Public read. */
export async function getPublishedPosts(): Promise<JournalPost[]> {
  const { data, error } = await supabase
    .from("journal_versions")
    .select(JOURNAL_SELECT)
    .eq("state", "published")
    .eq("published", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getPublishedPosts:", error.message);
    return [];
  }
  return ((data as unknown as JournalVersionRow[] | null) ?? []).map(mapPost);
}

/** A single published post by slug. */
export async function getPostBySlug(slug: string): Promise<JournalPost | null> {
  const { data, error } = await supabase
    .from("journal_versions")
    .select(JOURNAL_SELECT)
    .eq("state", "published")
    .eq("slug", slug)
    .eq("published", true)
    .maybeSingle();

  if (error) {
    console.error("getPostBySlug:", error.message);
    return null;
  }
  return data ? mapPost(data as unknown as JournalVersionRow) : null;
}

/**
 * Every post for the admin list, with drafts superseding their published
 * counterparts. Includes unpublished posts, which the storefront never sees.
 */
export async function getAdminPosts(
  client: SupabaseClient = supabase
): Promise<JournalPost[]> {
  const { data, error } = await client
    .from("journal_versions")
    .select(`${JOURNAL_SELECT}, state`)
    .in("state", ["published", "draft"])
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAdminPosts:", error.message);
    return [];
  }

  const rows = (data as unknown as (JournalVersionRow & { state: string })[]) ?? [];
  const byPost = new Map<string, JournalVersionRow & { state: string }>();
  for (const row of rows) {
    const seen = byPost.get(row.journal_id);
    if (!seen || row.state === "draft") byPost.set(row.journal_id, row);
  }
  return [...byPost.values()].map(mapPost);
}

/** Post ids with unpublished changes. */
export async function getDraftPostIds(
  client: SupabaseClient = supabase
): Promise<Set<string>> {
  const { data } = await client
    .from("journal_versions")
    .select("journal_id")
    .eq("state", "draft");
  return new Set((data ?? []).map((r) => r.journal_id as string));
}

import { supabase } from "./supabase";
import type { JournalPost } from "./types";

/** Published journal posts, newest first. Public read. */
export async function getPublishedPosts(): Promise<JournalPost[]> {
  const { data, error } = await supabase
    .from("journal_posts")
    .select("*")
    .eq("published", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getPublishedPosts:", error.message);
    return [];
  }
  return data ?? [];
}

/** A single published post by slug. */
export async function getPostBySlug(slug: string): Promise<JournalPost | null> {
  const { data, error } = await supabase
    .from("journal_posts")
    .select("*")
    .eq("slug", slug)
    .eq("published", true)
    .maybeSingle();

  if (error) {
    console.error("getPostBySlug:", error.message);
    return null;
  }
  return data;
}

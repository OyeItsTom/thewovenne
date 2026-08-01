import { supabase } from "./supabase";

/**
 * Where a path that no longer resolves has moved to.
 *
 * Backed by product_url_history (migration 0017), which records every path a
 * product has ever been published at. That is what makes renaming a product or
 * moving it between categories safe: the links it has already earned keep
 * working instead of breaking on the next change.
 *
 * Returns null when the path is unknown or the product is gone, in which case
 * the caller should 404 — redirecting to the homepage would tell a crawler the
 * page still exists.
 */
export async function resolveOldPath(path: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("resolve_product_path", {
    p_path: path,
  });

  if (error) {
    console.error("resolveOldPath:", error.message);
    return null;
  }
  const to = data as string | null;
  // Never redirect a path to itself — that is an infinite loop for the browser.
  return to && to !== path ? to : null;
}

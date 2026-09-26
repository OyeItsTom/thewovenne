import { supabase } from "./supabase";
import { getProductBySlug } from "./products";
import { ANON_CTX } from "./readCtx";
import { cPath, isCountry } from "./country";

/*
 * HISTORY PATHS ARE UNPREFIXED; REDIRECTS ARE NOT.
 *
 * product_url_history (migration 0017) predates the move under /in (#69) and
 * stores every path without a market: "/product/<slug>",
 * "/<parent>/<child>/<slug>". resolve_product_path() answers in the same shape.
 * So a lookup key must be built unprefixed, and the answer must be given its
 * market before a visitor is sent there.
 *
 * Both halves have been missed once. The flat route looked up
 * "/in/product/<slug>", which no row can match, so every renamed product's old
 * flat link 404'd. The category route redirected to the bare answer, which only
 * reached the page after middleware 308'd it a second time.
 */

/** The history key for the flat /in/product/<slug> URL. */
export function flatProductHistoryPath(slug: string): string {
  return `/product/${slug}`;
}

/** The history key for a /in/<parent>/<child>/<product> URL. */
export function categoryProductHistoryPath(
  parent: string,
  child: string,
  product: string
): string {
  return `/${parent}/${child}/${product}`;
}

export interface HistoryLookup {
  /** resolve_product_path: the product's current unprefixed path, or null. */
  lookup: (path: string) => Promise<string | null>;
  /** Whether a customer can open the product with this slug. */
  isReachable: (slug: string) => Promise<boolean>;
}

/**
 * A path on this site, and nothing a browser could read as another host:
 * no "//evil.com", no "https:", no backslashes (which browsers treat as "/").
 * product_path() only ever builds "/" + slugs, so this refuses nothing real.
 */
function isLocalPath(path: string): boolean {
  return /^\/(?![/\\])[^\\\s]*$/.test(path);
}

/**
 * Where an unprefixed history path has moved to, as a storefront URL.
 *
 * Returns null when there is nowhere to send the visitor, and the caller 404s:
 * redirecting to the homepage instead would tell a crawler the page still
 * exists.
 */
export async function resolveMovedPath(
  path: string,
  deps: HistoryLookup
): Promise<string | null> {
  const to = await deps.lookup(path);
  // Compared unprefixed, the way both sides are stored. Never redirect a path
  // to itself — that is an infinite loop for the browser.
  if (!to || to === path || !isLocalPath(to)) return null;

  // Only send a visitor somewhere they can actually get to. A product filed
  // under a hidden category still HAS a canonical path, so without this check a
  // dead link becomes a redirect that lands on a 404 — worse than 404ing
  // straight away, for crawlers and for people. Costs one query, and only on
  // the miss path.
  const slug = to.split("/").pop() ?? "";
  if (!(await deps.isReachable(slug))) return null;

  // The market goes on here, once, so the redirect lands on the page itself
  // rather than on middleware's 308 to it.
  return isCountry(to.split("/")[1] ?? "") ? to : cPath(to);
}

const live: HistoryLookup = {
  async lookup(path) {
    const { data, error } = await supabase.rpc("resolve_product_path", {
      p_path: path,
    });
    if (error) {
      console.error("resolveOldPath:", error.message);
      return null;
    }
    return data as string | null;
  },
  async isReachable(slug) {
    return (await getProductBySlug(slug, ANON_CTX)) !== null;
  },
};

/**
 * Where a path that no longer resolves has moved to.
 *
 * Backed by product_url_history (migration 0017), which records every path a
 * product has ever been published at. That is what makes renaming a product or
 * moving it between categories safe: the links it has already earned keep
 * working instead of breaking on the next change.
 *
 * Takes the UNPREFIXED history key — build it with flatProductHistoryPath or
 * categoryProductHistoryPath — and returns an /in storefront URL, or null.
 */
export async function resolveOldPath(path: string): Promise<string | null> {
  return resolveMovedPath(path, live);
}

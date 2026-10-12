import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DERIVATIVE_RECIPE,
  publicObjectUrl,
  storageKeyFromPublicUrl,
  type DerivedTier,
  type ImageVariantMap,
} from "./imageVariants";

/**
 * Reading public.image_derivatives (0071) for the storefront.
 *
 * ONE QUERY PER PRODUCT FETCH, for every photograph that fetch returned, and it
 * rides the same ISR cache as the product query itself. No sharp and nothing
 * Node-only here, so the data layer can import it without dragging the encoder
 * into every page.
 *
 * FAILS OPEN TO THE MASTER. If the table does not exist yet (this code can
 * deploy before 0071 is applied), or the read fails for any reason, the answer
 * is "no derivatives" and every image keeps pointing at its master — which is
 * exactly what the storefront did before this file existed. Logged once per
 * process, not once per render.
 */

let warned = false;

export type RegistryRow = { source_path: string; tier: DerivedTier; derived_path: string };

/** Turn registry rows into the map components read, keyed by master URL. */
export function variantMapFromRows(
  urlsByKey: Map<string, string[]>,
  rows: readonly RegistryRow[],
  supabaseUrl?: string
): ImageVariantMap {
  const map: ImageVariantMap = {};
  for (const row of rows) {
    const urls = urlsByKey.get(row.source_path);
    if (!urls) continue;
    if (row.tier !== "w1080" && row.tier !== "w1920") continue;
    const derivedUrl = publicObjectUrl(row.derived_path, supabaseUrl);
    if (!derivedUrl) continue;
    for (const url of urls) {
      (map[url] ??= {})[row.tier] = derivedUrl;
    }
  }
  return map;
}

/** Which bucket keys a set of stored URLs name, grouped so each key is asked once. */
export function keysForUrls(urls: Iterable<string>, supabaseUrl?: string): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const url of urls) {
    const key = storageKeyFromPublicUrl(url, supabaseUrl);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) {
      if (!list.includes(url)) list.push(url);
    } else {
      byKey.set(key, [url]);
    }
  }
  return byKey;
}

export async function loadImageVariants(
  client: SupabaseClient,
  urls: Iterable<string>
): Promise<ImageVariantMap> {
  const byKey = keysForUrls(urls);
  if (byKey.size === 0) return {};
  try {
    const { data, error } = await client
      .from("image_derivatives")
      .select("source_path, tier, derived_path")
      .eq("recipe", DERIVATIVE_RECIPE)
      .eq("status", "ready")
      .in("source_path", [...byKey.keys()]);
    if (error) throw new Error(error.message);
    return variantMapFromRows(byKey, (data ?? []) as RegistryRow[]);
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(
        `[image-variants] registry unavailable, serving masters: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {};
  }
}

/**
 * Attach each product's own slice of the map. Only that product's photographs,
 * so a card's payload grows by the derived URLs of the pictures it already
 * carries and nothing else.
 */
export async function attachImageVariants<
  T extends { images?: string[]; image_url: string | null; imageVariants?: ImageVariantMap },
>(products: T[], client: SupabaseClient): Promise<T[]> {
  if (products.length === 0) return products;
  const all = new Set<string>();
  for (const p of products) {
    if (p.image_url) all.add(p.image_url);
    for (const url of p.images ?? []) all.add(url);
  }
  const map = await loadImageVariants(client, all);
  if (Object.keys(map).length === 0) return products;
  return products.map((p) => {
    const own: ImageVariantMap = {};
    for (const url of [p.image_url, ...(p.images ?? [])]) {
      if (url && map[url]) own[url] = map[url];
    }
    return Object.keys(own).length ? { ...p, imageVariants: own } : p;
  });
}

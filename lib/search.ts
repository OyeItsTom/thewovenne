import { getAllProducts } from "./products";
import { ANON_CTX, type ReadCtx } from "./readCtx";
import type { Product } from "./types";

/**
 * Keyword search across the visible catalogue.
 *
 * SCORED IN MEMORY, DELIBERATELY. It reads the same visibility-scoped listing
 * every other page uses, so a hidden category cannot be reached by guessing a
 * product name — a search box that returns things the shop has taken down is a
 * back door with a text field in front of it.
 *
 * The trade is scale: this loads the visible catalogue to rank it. At this size
 * that costs nothing and buys a great deal — every field is searched the same
 * way, category and collection names included even though they live on joined
 * rows, and multi-word queries can be matched term by term. Past roughly a
 * thousand products this should become a Postgres full-text index with a
 * tsvector column; the signature here is built to survive that change.
 */

/** Field weights. A name match matters more than a word buried in prose. */
const WEIGHTS = {
  name: 10,
  category: 6,
  fabric: 5,
  colour: 5,
  collection: 4,
  description: 2,
} as const;

/** A whole-word hit beats a fragment, so "linen" ranks above "linens" in a blurb. */
function fieldScore(haystack: string | null, term: string, weight: number): number {
  if (!haystack) return 0;
  const text = haystack.toLowerCase();
  const at = text.indexOf(term);
  if (at === -1) return 0;

  const startsWord = at === 0 || !/[a-z0-9]/.test(text[at - 1]);
  const after = at + term.length;
  const endsWord = after === text.length || !/[a-z0-9]/.test(text[after]);

  if (startsWord && endsWord) return weight * 2;
  if (startsWord) return weight;
  return Math.round(weight / 2);
}

function scoreProduct(product: Product, terms: string[]): number {
  let total = 0;

  for (const term of terms) {
    const hit =
      fieldScore(product.name, term, WEIGHTS.name) +
      fieldScore(product.category, term, WEIGHTS.category) +
      fieldScore(product.fabric, term, WEIGHTS.fabric) +
      fieldScore(product.colour, term, WEIGHTS.colour) +
      fieldScore(product.collection, term, WEIGHTS.collection) +
      fieldScore(product.description, term, WEIGHTS.description);

    // EVERY term must land somewhere. Without this, "red saree" would return
    // every red thing in the shop alongside every saree, which reads as the
    // search having ignored half of what was typed.
    if (hit === 0) return 0;
    total += hit;
  }

  // A gentle nudge for things that can actually be bought. Not a filter —
  // hiding sold-out pieces makes a search look broken to someone who knows
  // the shop stocks them.
  if (product.stock_quantity > 0) total += 1;

  return total;
}

/** Whitespace-separated terms, deduped, with stray punctuation trimmed off. */
export function parseQuery(raw: string): string[] {
  const terms = raw
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((t) => t.length > 0);
  return [...new Set(terms)];
}

export interface SearchResult {
  products: Product[];
  terms: string[];
}

export async function searchProducts(
  raw: string,
  ctx: ReadCtx = ANON_CTX,
  limit = 60
): Promise<SearchResult> {
  const terms = parseQuery(raw);
  if (terms.length === 0) return { products: [], terms };

  const all = await getAllProducts(ctx);

  const ranked = all
    .map((product) => ({ product, score: scoreProduct(product, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.product);

  return { products: ranked, terms };
}

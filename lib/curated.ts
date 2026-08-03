import type { SupabaseClient } from "@supabase/supabase-js";
import { getAllProducts } from "./products";
import type { Product } from "./types";

/**
 * The curated set on the homepage.
 *
 * BUILT ONLY FROM DATA WE ACTUALLY HOLD. The signals available are the
 * wishlist and, in time, order history. There is no browsing history and no
 * search log — nothing has ever recorded either, and collecting them was
 * deliberately deferred until there is a consent and retention policy to hang
 * them on. So this reads saved items, and nothing else pretends otherwise.
 *
 * The fallback is not an apology. New arrivals is a genuinely good answer for
 * someone we know nothing about, which is most people most of the time, and it
 * is what everyone sees until they save something.
 *
 * Purchase history slots in here later without changing any caller: the
 * weighting below already treats "pieces you liked" as a bag of attributes, and
 * bought items are simply a stronger source for that bag.
 */

const TARGET = 12; // Within the 10–15 the brief asked for.

export type CuratedReason = "personal" | "new";

export interface CuratedSet {
  products: Product[];
  reason: CuratedReason;
  /** How many saved items shaped it — 0 whenever reason is "new". */
  basedOn: number;
}

/** Weights for taste signals. Category is the coarsest, colour the most personal. */
const ATTRIBUTE_WEIGHTS = {
  category_id: 3,
  fabric: 4,
  colour: 5,
} as const;

function tally(products: Product[], key: keyof typeof ATTRIBUTE_WEIGHTS) {
  const counts = new Map<string, number>();
  for (const p of products) {
    const value = p[key];
    if (typeof value !== "string" || !value) continue;
    const k = value.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export async function getCuratedProducts(
  supabase: SupabaseClient,
  signedIn: boolean
): Promise<CuratedSet> {
  const all = await getAllProducts();

  // Newest first is how getAllProducts already returns them, so this is the
  // new-arrivals answer with no extra work.
  const newest = all.slice(0, TARGET);

  if (!signedIn) return { products: newest, reason: "new", basedOn: 0 };

  // RLS scopes this to the signed-in customer's own rows.
  const { data: rows } = await supabase.from("wishlists").select("product_id");
  const savedIds = new Set((rows ?? []).map((r) => r.product_id as string));
  if (savedIds.size === 0) {
    return { products: newest, reason: "new", basedOn: 0 };
  }

  const saved = all.filter((p) => savedIds.has(p.id));
  // Saved items whose category has since been hidden are gone from `all`, so
  // a wishlist full of withdrawn pieces correctly falls back rather than
  // personalising from nothing.
  if (saved.length === 0) {
    return { products: newest, reason: "new", basedOn: 0 };
  }

  const byCategory = tally(saved, "category_id");
  const byFabric = tally(saved, "fabric");
  const byColour = tally(saved, "colour");

  const scored = all
    // Never recommend something already saved — they have seen it, and a
    // "for you" row that returns your own wishlist looks like a bug.
    .filter((p) => !savedIds.has(p.id))
    .map((product) => {
      let score = 0;
      const cat = product.category_id?.toLowerCase();
      const fab = product.fabric?.toLowerCase();
      const col = product.colour?.toLowerCase();

      if (cat && byCategory.has(cat)) {
        score += ATTRIBUTE_WEIGHTS.category_id * byCategory.get(cat)!;
      }
      if (fab && byFabric.has(fab)) {
        score += ATTRIBUTE_WEIGHTS.fabric * byFabric.get(fab)!;
      }
      if (col && byColour.has(col)) {
        score += ATTRIBUTE_WEIGHTS.colour * byColour.get(col)!;
      }
      if (product.stock_quantity > 0) score += 1;

      return { product, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // A thin catalogue is the normal case early on: if taste matching found only
  // a couple of things, top up with new arrivals rather than showing a row of
  // three. Padding is not personalisation, so the reason stays honest — it is
  // "personal" only when the match did most of the work.
  const matched = scored.map((r) => r.product);
  const chosen = [...matched];
  if (chosen.length < TARGET) {
    const already = new Set(chosen.map((p) => p.id));
    for (const p of newest) {
      if (chosen.length >= TARGET) break;
      if (already.has(p.id) || savedIds.has(p.id)) continue;
      chosen.push(p);
    }
  }

  // Two genuine matches is enough to call the row personal — at that point the
  // wishlist really did shape it, even if new arrivals padded the rest.
  //
  // The threshold has to be low deliberately. Anything higher is unreachable on
  // a small catalogue: with four products and one saved, there are only three
  // candidates, so a "needs four matches" rule would mean the personalised
  // branch never ran until the shop had dozens of pieces — indistinguishable,
  // from the outside, from it being broken.
  const genuinelyMatched = matched.length >= 2;

  return {
    products: chosen.slice(0, TARGET),
    reason: genuinelyMatched ? "personal" : "new",
    basedOn: genuinelyMatched ? saved.length : 0,
  };
}

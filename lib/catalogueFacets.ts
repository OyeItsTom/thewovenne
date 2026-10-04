/**
 * The customer-facing vocabulary of the catalogue's filters.
 *
 * WHAT A CUSTOMER BROWSES BY IS NOT WHAT THE ADMIN TYPED. The Fabric column is
 * one free-text field that, for half the catalogue, carries four facts at once:
 * "Handloom 120 count mul cotton" is a craft, a yarn count, a weave and a fibre.
 * Every word of it is true and stays on the product page and in its structured
 * data exactly as written. But as a filter option it is a sentence, and it sits
 * beside "Cotton" as though they were the same kind of thing. A customer
 * choosing a cloth wants "Mul Cotton".
 *
 * So this module maps stored values to browsing facets, and nothing else. It is
 * read only when a listing offers or applies a filter; it never writes, and no
 * product page, meta description, JSON-LD `material` or Ask Wovenne answer goes
 * through it.
 *
 * AN EXACT TABLE, NOT A PATTERN. Only the three labels the PR #174 audit
 * verified are mapped, matched on the whole value (case and spacing ignored).
 * Anything else passes through as typed — a new fabric appears as its own
 * option the moment a product uses it, rather than being guessed into a group.
 * Notably "Cotton" is NOT folded into anything: whether the plain-cotton sarees
 * are also mul or handloom is an open question for the owner, and a filter that
 * answered it would be making a claim the data does not.
 *
 * PURE: no React, no Next, no database. Tested in scripts/catalogue-facets.test.ts.
 */

/** The browsing facets, in the order a Fabric filter lists them. */
export const FABRIC_FACETS = ["Cotton", "Mul Cotton", "Tissue Cotton"] as const;

/** Stored value (normalised) → facet. Keys are lower-case, single-spaced. */
const FABRIC_FACET_BY_STORED: Readonly<Record<string, (typeof FABRIC_FACETS)[number]>> = {
  cotton: "Cotton",
  "handloom 120 count mul cotton": "Mul Cotton",
  "mul cotton": "Mul Cotton",
  "tissue cotton": "Tissue Cotton",
};

/** Case-folded, trimmed, inner whitespace collapsed: the comparison key. */
export function facetKey(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

/**
 * The Fabric facet a stored value is browsed under. Null for an empty value —
 * every piece of jewellery — which therefore appears under no Fabric option.
 */
export function fabricFacet(stored: string | null | undefined): string | null {
  const key = facetKey(stored);
  if (!key) return null;
  return FABRIC_FACET_BY_STORED[key] ?? (stored ?? "").trim().replace(/\s+/g, " ");
}

/** A Colour facet is the stored value itself, trimmed. Colour means the body colour. */
export function colourFacet(stored: string | null | undefined): string | null {
  const value = (stored ?? "").trim().replace(/\s+/g, " ");
  return value || null;
}

/**
 * Whether a stored fabric falls under any of the chosen facets. An empty choice
 * matches everything. The CHOICE goes through the table too, so a link written
 * before this module (?fabric=Handloom 120 count mul cotton) still means Mul
 * Cotton rather than silently matching nothing.
 */
export function matchesFabric(
  stored: string | null | undefined,
  chosen: readonly string[]
): boolean {
  if (chosen.length === 0) return true;
  const facet = facetKey(fabricFacet(stored));
  return !!facet && chosen.some((c) => facetKey(fabricFacet(c)) === facet);
}

/** Whether a stored colour is one of the chosen ones. An empty choice matches everything. */
export function matchesColour(
  stored: string | null | undefined,
  chosen: readonly string[]
): boolean {
  if (chosen.length === 0) return true;
  const colour = facetKey(stored);
  return !!colour && chosen.some((c) => facetKey(c) === colour);
}

/**
 * Distinct facets for a set of stored values, each shown with the first
 * spelling seen. Known fabric facets keep their fixed order (Cotton, Mul
 * Cotton, Tissue Cotton); anything else follows alphabetically.
 */
export function fabricOptions(stored: readonly (string | null | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const value of stored) {
    const facet = fabricFacet(value);
    if (facet && !seen.has(facetKey(facet))) seen.set(facetKey(facet), facet);
  }
  const rank = (f: string) => {
    const i = FABRIC_FACETS.findIndex((known) => facetKey(known) === facetKey(f));
    return i === -1 ? FABRIC_FACETS.length : i;
  };
  return [...seen.values()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Distinct colours, case-insensitively, alphabetical. */
export function colourOptions(stored: readonly (string | null | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const value of stored) {
    const colour = colourFacet(value);
    if (colour && !seen.has(facetKey(colour))) seen.set(facetKey(colour), colour);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * The options a filter GROUP offers, or none.
 *
 * A group is worth showing only if choosing in it can change the result. With
 * no options there is nothing to choose; with ONE, every product in view that
 * has the attribute has that value, so the choice is a no-op (Men/Dhoti's lone
 * "Cotton") — clutter that looks like a control. So both are hidden.
 *
 * The exception is a choice already made — usually arriving on a shared link —
 * which stays on show, chosen, so it can be seen and undone from the panel as
 * well as from its chip.
 */
export function narrowingOptions(
  options: readonly string[],
  chosen: readonly string[] = []
): string[] {
  const missing = chosen.filter(
    (c) => !options.some((o) => facetKey(o) === facetKey(c))
  );
  if (options.length < 2 && chosen.length === 0) return [];
  return [...options, ...missing];
}

/**
 * Sizes are only comparable within one kind of thing: a ring's 6 and a shirt's
 * M are not two options of one filter. So a listing offers sizes only when
 * everything in it belongs to ONE sub-category, and the group is named for it.
 *
 * Returns the sub-category's name (for the title), or null when the listing
 * spans several and Size must not be offered at all.
 */
export function singleSubCategory(
  products: readonly { category_slug: string | null; category: string | null }[]
): { slug: string; name: string } | null {
  const slugs = new Set(products.map((p) => p.category_slug ?? ""));
  if (slugs.size !== 1) return null;
  const first = products[0];
  if (!first?.category_slug) return null;
  return { slug: first.category_slug, name: first.category ?? first.category_slug };
}

/**
 * "Ring size" for rings; plain "Size" for everything else. A ring size is a
 * different measurement from a garment size, and naming it stops a lone "6"
 * reading as a dress size. Deliberately small: only kinds whose size is a
 * measurement of their own get a name.
 */
export function sizeGroupTitle(subCategoryName: string | null | undefined): string {
  const name = facetKey(subCategoryName);
  if (/^(couple )?rings?$/.test(name)) return "Ring size";
  if (/^bangles?$/.test(name)) return "Bangle size";
  return "Size";
}

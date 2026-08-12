/**
 * The catalogue's URL contract.
 *
 * A filtered listing is a place, not a mood. It should survive a refresh, come
 * back correctly with the back button, and mean the same thing when somebody
 * sends it to a friend. That only works if the filters live in the URL rather
 * than in a component's memory, which is what they did before this.
 *
 * PURE AND SERVER-SAFE. No React, no Next, no database — parsing here and
 * nothing else, so both the server page and the client controls can agree on
 * what a URL means, and so it can be tested without a browser.
 *
 * DELIBERATELY SMALL. Sorting and paging are not parsed here yet; they are
 * separate pieces of work. The shape is additive — a `sort` and a `page` key
 * slot in beside these without changing how anything already written reads a
 * URL.
 */

export interface CatalogueFilters {
  /** Sub-category slug, e.g. "sarees". Null means every visible category. */
  category: string | null;
  fabric: string | null;
  colour: string | null;
  size: string | null;
  /** Inclusive upper bound in rupees. Null means no ceiling. */
  maxPrice: number | null;
}

export const NO_FILTERS: CatalogueFilters = {
  category: null,
  fabric: null,
  colour: null,
  size: null,
  maxPrice: null,
};

/** What a page receives from Next: values may be absent, single, or repeated. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** First value only. A repeated key is a crafted URL, not a customer. */
function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = (v ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Read a URL into filters.
 *
 * Tolerant by design: anything unrecognised is dropped rather than 404'd. A
 * mangled link should show the catalogue, not an error — the customer did not
 * type it.
 *
 * Values are capped in length because they reach a database query. They are
 * still passed as bound parameters by the client library, so this is belt and
 * braces rather than the actual defence.
 */
export function parseCatalogueParams(params: RawSearchParams): CatalogueFilters {
  const price = one(params.maxPrice);
  const parsedPrice = price === null ? NaN : Number(price);

  return {
    category: cap(one(params.category)),
    fabric: cap(one(params.fabric)),
    colour: cap(one(params.colour)),
    size: cap(one(params.size)),
    // Positive and finite, or absent. "0" and "-5" are not ceilings anyone means.
    maxPrice:
      Number.isFinite(parsedPrice) && parsedPrice > 0
        ? Math.min(parsedPrice, 100_000_000)
        : null,
  };
}

function cap(value: string | null): string | null {
  return value === null ? null : value.slice(0, 80);
}

/** True when nothing is filtered — the plain catalogue view. */
export function isUnfiltered(filters: CatalogueFilters): boolean {
  return (
    filters.category === null &&
    filters.fabric === null &&
    filters.colour === null &&
    filters.size === null &&
    filters.maxPrice === null
  );
}

/**
 * Filters back into a query string.
 *
 * KEYS IN A FIXED ORDER, and empty ones omitted. Two identical filter states
 * produce byte-identical navigation URLs and cache inputs. This is deterministic
 * parameter writing, not a complete faceted-search canonical/noindex policy.
 */
export function catalogueSearchString(filters: CatalogueFilters): string {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.fabric) params.set("fabric", filters.fabric);
  if (filters.colour) params.set("colour", filters.colour);
  if (filters.size) params.set("size", filters.size);
  if (filters.maxPrice !== null) params.set("maxPrice", String(filters.maxPrice));
  return params.toString();
}

/** A full href for a listing at these filters. Bare path when nothing is set. */
export function catalogueHref(pathname: string, filters: CatalogueFilters): string {
  const search = catalogueSearchString(filters);
  return search ? `${pathname}?${search}` : pathname;
}

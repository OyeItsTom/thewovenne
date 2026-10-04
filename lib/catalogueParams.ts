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
 * DELIBERATELY SMALL. Paging is not parsed here yet. `availability` and `sort`
 * were added additively (Premium UX PR 2): no URL that worked before reads any
 * differently now.
 *
 * FABRIC AND COLOUR ARE LISTS (Natural Fabric PR #175). A customer can want
 * Cotton OR Mul Cotton, so each may repeat — ?fabric=Cotton&fabric=Mul+Cotton —
 * and a product matches if it is any of them. A single ?fabric=Cotton is the
 * one-item list it always was. Fabric values are read as their browsing facet
 * (lib/catalogueFacets), so a link written before facets existed,
 * ?fabric=Handloom+120+count+mul+cotton, now reads — and is rewritten — as
 * Mul Cotton.
 */
import { fabricFacet } from "./catalogueFacets";

/**
 * The customer-facing orders, and nothing more.
 *
 * There is no "Recommended": nothing in the catalogue ranks products, and a
 * label promising curation over what is really "newest" would be a small lie.
 * Null — the default, never written to the URL — is newest product first, the
 * order every listing has always used. See lib/catalogueDiscovery.
 */
export type CatalogueSort = "price-asc" | "price-desc";
export const CATALOGUE_SORTS: readonly CatalogueSort[] = ["price-asc", "price-desc"];

export interface CatalogueFilters {
  /** Sub-category slug, e.g. "sarees". Null means every visible category. */
  category: string | null;
  /** Fabric facets (lib/catalogueFacets), any of which matches. Empty: no filter. */
  fabric: string[];
  /** Body colours, any of which matches. Empty: no filter. */
  colour: string[];
  size: string | null;
  /** Inclusive upper bound in rupees. Null means no ceiling. */
  maxPrice: number | null;
  /** Only pieces that can be bought right now. Written as availability=in-stock. */
  inStock: boolean;
  /**
   * An ORDER, not a filter: isUnfiltered() ignores it, and it is never part of
   * a catalogue query — the page orders the result. Null is the default order.
   */
  sort: CatalogueSort | null;
}

export const NO_FILTERS: CatalogueFilters = {
  category: null,
  fabric: [],
  colour: [],
  size: null,
  maxPrice: null,
  inStock: false,
  sort: null,
};

/** What a page receives from Next: values may be absent, single, or repeated. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** First value only. A repeated key is a crafted URL, not a customer. */
function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = (v ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** At most this many values per list. Nobody ticks nine colours; a URL might. */
const MAX_LIST = 8;

/**
 * Every value of a repeatable key: trimmed, capped, de-duplicated without
 * regard to case (the catalogue matches that way), and SORTED, so the same
 * choice made in a different order is the same URL and the same cache entry.
 */
function list(
  value: string | string[] | undefined,
  normalise: (v: string) => string | null = (v) => v
): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const seen = new Map<string, string>();
  for (const v of raw) {
    const capped = cap((v ?? "").trim() || null);
    const n = capped === null ? null : normalise(capped);
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  }
  return [...seen.values()]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, MAX_LIST);
}

/**
 * A URLSearchParams as the record Next hands a page, repeated keys kept as
 * arrays. Client listings read window.location through this, so they see
 * exactly what the server would.
 */
export function searchParamsRecord(params: URLSearchParams): RawSearchParams {
  const record: RawSearchParams = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    record[key] = values.length === 1 ? values[0] : values;
  }
  return record;
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
    fabric: list(params.fabric, fabricFacet),
    colour: list(params.colour),
    size: cap(one(params.size)),
    // Positive and finite, or absent. "0" and "-5" are not ceilings anyone means.
    // Whole rupees: prices are, and a slider never writes a fraction.
    maxPrice:
      Number.isFinite(parsedPrice) && parsedPrice >= 1
        ? Math.min(Math.round(parsedPrice), 100_000_000)
        : null,
    // One spelling only. Anything else is a mangled link, read as "everything".
    inStock: one(params.availability) === "in-stock",
    sort: parseSort(one(params.sort)),
  };
}

function parseSort(value: string | null): CatalogueSort | null {
  return CATALOGUE_SORTS.find((s) => s === value) ?? null;
}

function cap(value: string | null): string | null {
  return value === null ? null : value.slice(0, 80);
}

/** True when nothing is filtered — the plain catalogue view. */
export function isUnfiltered(filters: CatalogueFilters): boolean {
  return (
    filters.category === null &&
    filters.fabric.length === 0 &&
    filters.colour.length === 0 &&
    filters.size === null &&
    filters.maxPrice === null &&
    !filters.inStock
  );
}

/**
 * The part of the state a catalogue QUERY depends on — everything but the sort.
 *
 * Built field by field so the bare shop and a filtered page's "everything" read
 * hand the cache byte-identical arguments, and so a sort never becomes a cache
 * key of its own: every order shares the one answer per filter combination.
 */
export function catalogueQuery(filters: CatalogueFilters): Omit<CatalogueFilters, "sort"> {
  return {
    category: filters.category,
    fabric: sortedList(filters.fabric),
    colour: sortedList(filters.colour),
    size: filters.size,
    maxPrice: filters.maxPrice,
    inStock: filters.inStock,
  };
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
  for (const fabric of sortedList(filters.fabric)) params.append("fabric", fabric);
  for (const colour of sortedList(filters.colour)) params.append("colour", colour);
  if (filters.size) params.set("size", filters.size);
  if (filters.maxPrice !== null) params.set("maxPrice", String(filters.maxPrice));
  if (filters.inStock) params.set("availability", "in-stock");
  if (filters.sort) params.set("sort", filters.sort);
  return params.toString();
}

/** The order a list is written in — the parser's, so a round trip is stable. */
function sortedList(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** A full href for a listing at these filters. Bare path when nothing is set. */
export function catalogueHref(pathname: string, filters: CatalogueFilters): string {
  const search = catalogueSearchString(filters);
  return search ? `${pathname}?${search}` : pathname;
}

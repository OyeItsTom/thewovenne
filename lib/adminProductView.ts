/**
 * Search, filter and sort for the Admin Products list.
 *
 * VIEW ONLY. Every function here takes the rows the page already loaded
 * (getAdminProducts — one read when the page opens) and returns a re-ordered
 * subset of them. Nothing is fetched, nothing is written: a filter cannot edit
 * a product, save a draft, publish or move stock, because it never holds a
 * database handle. Pure functions, so the rules are testable without a browser.
 *
 * ── TWO DATES, ON PURPOSE ──
 *
 *   product_created_at  when the PRODUCT was first created (products.created_at).
 *                       Never changes. "Newest" / "Oldest" use this — the same
 *                       date the storefront orders by since #167.
 *   created_at          when the VERSION shown was made. Every edit forks a
 *                       draft stamped now() and publishing promotes it, so this
 *                       is effectively "last edited". "Recently edited" uses it,
 *                       and it is the list's default order (what the table has
 *                       always shown).
 *
 * Mixing them up is the bug #167 fixed on the storefront: a typo fix made a
 * months-old saree look newly added.
 */
import type { Product } from "./types";

export type StatusFilter = "all" | "active" | "hidden" | "unpublished";
export type StockFilter = "all" | "in" | "out";
export type SortMode =
  | "recent"
  | "name-asc"
  | "name-desc"
  | "newest"
  | "oldest"
  | "price-asc"
  | "price-desc"
  | "stock-asc"
  | "stock-desc";

/** "" means "any". NOT_SET matches products with the field empty. */
export const NOT_SET = "__not_set__";

export interface ProductView {
  query: string;
  status: StatusFilter;
  category: string;
  fabric: string;
  colour: string;
  stock: StockFilter;
  sort: SortMode;
}

export const DEFAULT_VIEW: ProductView = {
  query: "",
  status: "all",
  category: "",
  fabric: "",
  colour: "",
  stock: "all",
  sort: "recent",
};

export const SORT_LABELS: Record<SortMode, string> = {
  recent: "Recently edited",
  "name-asc": "Name A–Z",
  "name-desc": "Name Z–A",
  newest: "Newest product",
  oldest: "Oldest product",
  "price-asc": "Price low → high",
  "price-desc": "Price high → low",
  "stock-asc": "Stock low → high",
  "stock-desc": "Stock high → low",
};

export const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "Any status",
  active: "Active",
  hidden: "Hidden",
  unpublished: "Unpublished changes",
};

/** Same comparison the shop's filters use: trimmed, case-insensitive. */
function key(v: string | null | undefined): string {
  return (v ?? "").trim().toLocaleLowerCase("en");
}

/**
 * The text a search matches against. Status is deliberately NOT in it:
 * searching "hidden" should find a product called hidden, not every hidden
 * product — that is what the Status filter is for.
 */
function haystack(p: Product): string {
  return [p.name, p.slug, p.fabric, p.colour, p.category, p.category_parent_slug, p.collection]
    .map(key)
    .join(" \u0001 ");
}

/**
 * Values offered in a filter dropdown, read from the loaded rows rather than a
 * fixed list — so a new fabric appears the moment a product uses it. Collapsed
 * case-insensitively ("Gold"/"gold" are one option, first spelling kept),
 * sorted, plus whether any row has the field empty.
 */
export function optionsFor(
  products: Product[],
  get: (p: Product) => string | null | undefined
): { values: string[]; hasEmpty: boolean } {
  const seen = new Map<string, string>();
  let hasEmpty = false;
  for (const p of products) {
    const raw = get(p)?.trim();
    if (!raw) {
      hasEmpty = true;
      continue;
    }
    if (!seen.has(key(raw))) seen.set(key(raw), raw);
  }
  return {
    values: [...seen.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
    hasEmpty,
  };
}

function matchesValue(value: string | null | undefined, wanted: string): boolean {
  if (!wanted) return true;
  if (wanted === NOT_SET) return key(value) === "";
  return key(value) === key(wanted);
}

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const byName = (a: Product, b: Product) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true });

/** Missing dates always sort last, whichever direction is chosen. */
function byDate(get: (p: Product) => string | null | undefined, dir: 1 | -1) {
  return (a: Product, b: Product) => {
    const ta = time(get(a));
    const tb = time(get(b));
    if (ta === null && tb === null) return byName(a, b);
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta === tb ? byName(a, b) : (ta - tb) * dir;
  };
}

function byNumber(get: (p: Product) => number, dir: 1 | -1) {
  return (a: Product, b: Product) => {
    const d = (get(a) - get(b)) * dir;
    return d === 0 ? byName(a, b) : d;
  };
}

const COMPARATORS: Record<SortMode, (a: Product, b: Product) => number> = {
  recent: byDate((p) => p.created_at, -1),
  "name-asc": byName,
  "name-desc": (a, b) => byName(b, a),
  newest: byDate((p) => p.product_created_at, -1),
  oldest: byDate((p) => p.product_created_at, 1),
  "price-asc": byNumber((p) => p.price_inr, 1),
  "price-desc": byNumber((p) => p.price_inr, -1),
  "stock-asc": byNumber((p) => p.stock_quantity, 1),
  "stock-desc": byNumber((p) => p.stock_quantity, -1),
};

/**
 * The rows to show, in order. Returns a NEW array; the input is never touched.
 * `draftIds` is the set the page already loads for the "Unpublished" badge.
 */
export function applyProductView(
  products: readonly Product[],
  view: ProductView,
  draftIds: ReadonlySet<string> = new Set()
): Product[] {
  const terms = key(view.query).split(/\s+/).filter(Boolean);
  return products
    .filter((p) => {
      if (terms.length) {
        const text = haystack(p);
        if (!terms.every((t) => text.includes(t))) return false;
      }
      if (view.status === "active" && !p.is_active) return false;
      if (view.status === "hidden" && p.is_active) return false;
      if (view.status === "unpublished" && !draftIds.has(p.id)) return false;
      if (!matchesValue(p.category, view.category)) return false;
      if (!matchesValue(p.fabric, view.fabric)) return false;
      if (!matchesValue(p.colour, view.colour)) return false;
      if (view.stock === "in" && !(p.stock_quantity > 0)) return false;
      if (view.stock === "out" && p.stock_quantity > 0) return false;
      return true;
    })
    .sort(COMPARATORS[view.sort]);
}

/** Whether anything differs from the default view — drives "Clear filters". */
export function isDefaultView(view: ProductView): boolean {
  return (Object.keys(DEFAULT_VIEW) as (keyof ProductView)[]).every((k) =>
    k === "query" ? view.query.trim() === "" : view[k] === DEFAULT_VIEW[k]
  );
}

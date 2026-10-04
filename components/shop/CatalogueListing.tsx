"use client";

import { useState } from "react";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import type { ProductListing } from "@/lib/types";
import type { CatalogueFilters, CatalogueSort } from "@/lib/catalogueParams";
import {
  SORT_OPTIONS,
  activeFilters,
  clearedFilters,
  resultCountLabel,
  withoutFilter,
} from "@/lib/catalogueDiscovery";
import FilterSidebar, {
  hasFilterOptions,
  type FilterOptions,
} from "@/components/shop/FilterSidebar";
import ProductGrid from "@/components/shop/ProductGrid";

/**
 * One listing, laid out the same way wherever it appears: Shop, a section
 * (/in/women) and a sub-category (/in/women/sarees).
 *
 *   30 products                                Sort  Newest ⌄
 *   [In stock ×] [Mul Cotton ×]                         (only when filtered)
 *   ─────────────────────────────────────────────────────────
 *   FILTERS  Clear all │  grid
 *   Fabric          +  │
 *
 * On a phone the sidebar becomes a drawer, and the first line becomes the
 * Filters button and the sort — the two controls a thumb needs — with the
 * count and any chosen filters beneath them. Nothing else sits above the
 * products.
 *
 * PRESENTATION ONLY. It neither filters nor orders: the products arrive final,
 * and every change is handed to `onChange`. The shop turns that into a
 * navigation (the database filters); a category page into state over the list
 * it already holds. The shared shape is what keeps the two pages the same.
 */
export default function CatalogueListing({
  products,
  total,
  filters,
  options,
  onChange,
  pending = false,
}: {
  /** Already filtered and ordered. */
  products: ProductListing[];
  /** How many this listing holds unfiltered — the "of 30". */
  total: number;
  filters: CatalogueFilters;
  options: FilterOptions;
  onChange: (filters: CatalogueFilters) => void;
  /** Shown while the shop's server answer is on its way. */
  pending?: boolean;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const categoryNames = new Map(
    options.categoryGroups.flatMap((g) => g.children.map((c) => [c.slug, c.name] as const))
  );
  const chips = activeFilters(
    filters,
    (slug) => categoryNames.get(slug) ?? null,
    options.sizeTitle
  );
  const count = resultCountLabel(products.length, total);
  const showFilters = hasFilterOptions(options, filters) || chips.length > 0;
  const clearAll = () => onChange(clearedFilters(filters));

  return (
    <div className="mt-10 sm:mt-12">
      <div className="flex min-h-[44px] items-center justify-between gap-4 border-b border-ink/10 pb-3">
        {showFilters && (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-haspopup="dialog"
            className="-ml-1 inline-flex min-h-[44px] flex-shrink-0 items-center gap-2 px-1 text-sm uppercase tracking-wider text-ink lg:hidden"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Filters
            {chips.length > 0 && (
              <span className="text-ink-muted">
                <span aria-hidden>({chips.length})</span>
                <span className="sr-only">, {chips.length} applied</span>
              </span>
            )}
          </button>
        )}
        <p
          role="status"
          className={`text-sm text-ink-muted ${showFilters ? "hidden lg:block" : ""}`}
        >
          {count}
        </p>
        <SortSelect
          value={filters.sort}
          onChange={(sort) => onChange({ ...filters, sort })}
        />
      </div>

      {(showFilters || chips.length > 0) && (
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-2 pt-4 ${
            chips.length === 0 ? "lg:hidden" : ""
          }`}
        >
          {showFilters && (
            <p role="status" className="mr-1 text-sm text-ink-muted lg:hidden">
              {count}
            </p>
          )}
          {chips.length > 0 && (
            <>
              <ul aria-label="Applied filters" className="flex flex-wrap gap-2">
                {chips.map((chip) => (
                  <li key={`${chip.key}:${chip.value ?? ""}`}>
                    <button
                      type="button"
                      onClick={() => onChange(withoutFilter(filters, chip.key, chip.value))}
                      aria-label={`Remove filter: ${chip.label}`}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-ink/15 px-3 text-sm text-ink transition-colors hover:border-ink/50"
                    >
                      {chip.label}
                      <X className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
              {/* On a phone this is the visible way out with the drawer shut. On
                  desktop the sidebar's own header carries Clear all, so it is
                  not said twice. */}
              <button
                type="button"
                onClick={clearAll}
                className="min-h-[36px] text-sm text-ink underline underline-offset-4 hover:text-terracotta-dark lg:hidden"
              >
                Clear all
              </button>
            </>
          )}
        </div>
      )}

      <div className="mt-8 flex flex-col gap-10 lg:flex-row lg:gap-12">
        {showFilters && (
          <FilterSidebar
            options={options}
            filters={filters}
            onChange={onChange}
            isOpen={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            resultLabel={`${products.length} ${products.length === 1 ? "product" : "products"}`}
            onClearAll={clearAll}
            pending={pending}
          />
        )}

        <div className="min-w-0 flex-1">
          {/* aria-busy rather than a spinner: the results are already on screen
              and about to be replaced, so the honest signal is that they are
              stale, not that the page is empty. */}
          <div
            aria-busy={pending}
            className={pending ? "opacity-60 transition-opacity duration-200" : undefined}
          >
            {products.length === 0 ? (
              <div className="py-20 text-center">
                <p className="font-heading text-xl text-ink">
                  No products match these filters.
                </p>
                {/* A dead end needs a way out — not a rail of unrelated
                    products, just the one control that undoes it. */}
                <button
                  type="button"
                  onClick={clearAll}
                  className="mt-5 min-h-[44px] rounded-full border border-ink px-6 text-sm uppercase tracking-wider text-ink transition-colors hover:bg-ink hover:text-cream"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <ProductGrid products={products} headingLevel={2} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A native <select>: the phone's own picker, the keyboard behaviour everyone
 * already knows, and a real label. Styled down to a line of text.
 */
function SortSelect({
  value,
  onChange,
}: {
  value: CatalogueSort | null;
  onChange: (sort: CatalogueSort | null) => void;
}) {
  return (
    // min-w-0 down the chain: on the narrowest phones the select gives way
    // (its text truncates) instead of pushing the row past the screen edge.
    <label className="ml-auto flex min-h-[44px] min-w-0 items-center gap-2 text-sm">
      <span className="text-ink-muted">Sort</span>
      <span className="relative min-w-0">
        <select
          value={value ?? "newest"}
          onChange={(e) =>
            onChange(e.target.value === "newest" ? null : (e.target.value as CatalogueSort))
          }
          className="w-full min-w-0 cursor-pointer appearance-none truncate bg-transparent py-2 pr-6 text-ink"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        />
      </span>
    </label>
  );
}

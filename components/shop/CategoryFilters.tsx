"use client";

import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { Product } from "@/lib/types";
import ProductGrid from "./ProductGrid";
import FilterSidebar, {
  EMPTY_FILTERS,
  type Filters,
  type FilterOptions,
} from "./FilterSidebar";
import {
  availableSizes,
  distinctValues,
  matchesFilters,
  type SizesByProduct,
} from "@/lib/productFilters";

/**
 * Size, colour and material for one sub-category listing.
 *
 * Filtering happens in the browser over a server-fetched list: a sub-category
 * holds tens of products, not thousands, so a round trip per click would be
 * slower and no more correct. If a section ever grows past that, this becomes
 * a server-side query — the shared matcher means the rule itself would not
 * change.
 *
 * No category filter here, unlike the shop-wide listing: you are already inside
 * one, and offering to filter by it again is noise.
 */
export default function CategoryFilters({
  products,
  sizesByProduct,
}: {
  products: Product[];
  sizesByProduct: SizesByProduct;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [mobileOpen, setMobileOpen] = useState(false);

  const options: FilterOptions = useMemo(
    () => ({
      categoryGroups: [],
      fabrics: distinctValues(products, (p) => p.fabric),
      colours: distinctValues(products, (p) => p.colour),
      // Empty for sarees, which have no sizes — so the Size filter simply is
      // not rendered, with nothing anywhere naming that category.
      sizes: availableSizes(products, sizesByProduct),
    }),
    [products, sizesByProduct]
  );

  const filtered = useMemo(
    () => products.filter((p) => matchesFilters(p, filters, sizesByProduct)),
    [products, filters, sizesByProduct]
  );

  const nothingToFilter =
    options.sizes.length === 0 &&
    options.fabrics.length === 0 &&
    options.colours.length === 0;

  // A filter panel offering nothing is worse than no panel.
  if (nothingToFilter) {
    return <ProductGrid products={products} />;
  }

  return (
    <div className="flex flex-col gap-10 lg:flex-row lg:gap-12">
      <button
        onClick={() => setMobileOpen(true)}
        className="flex items-center gap-2 self-start rounded-full border border-ink/15 px-5 py-2.5 text-sm uppercase tracking-wider text-ink lg:hidden"
      >
        <SlidersHorizontal className="h-4 w-4" /> Filters
      </button>

      <FilterSidebar
        options={options}
        filters={filters}
        onChange={setFilters}
        isOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />

      <div className="flex-1">
        {filtered.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-sm text-ink/60">
              No pieces match those filters just yet.
            </p>
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="mt-3 text-sm uppercase tracking-wider text-terracotta underline-offset-4 hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <>
            <p className="mb-6 text-xs uppercase tracking-wider text-ink/50">
              {filtered.length} of {products.length}
            </p>
            <ProductGrid products={filtered} />
          </>
        )}
      </div>
    </div>
  );
}

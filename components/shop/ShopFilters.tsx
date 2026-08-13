"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import type { CategoryNode, ProductListing } from "@/lib/types";
import FilterSidebar, {
  type FilterOptions,
  type Filters,
} from "@/components/shop/FilterSidebar";
import ProductGrid from "@/components/shop/ProductGrid";
import { availableSizes, type SizesByProduct } from "@/lib/productFilters";
import {
  catalogueHref,
  NO_FILTERS,
  type CatalogueFilters,
} from "@/lib/catalogueParams";

/**
 * The filter controls. It no longer does any filtering.
 *
 * WHAT CHANGED. This component used to receive every product in the shop and
 * narrow the array in the browser, holding the chosen filters in useState. That
 * meant the whole catalogue was serialised into the page — 1,052 characters per
 * product, measured — and that a filtered view had no address: it could not be
 * refreshed, shared, or returned to with the back button.
 *
 * Now the URL is the state. Choosing a filter navigates; the server reads the
 * search params, asks the database, and sends back only what matched. This
 * component renders controls and results and owns neither.
 *
 * THE GRID AND THE CARDS ARE UNTOUCHED. Nothing here is a visual change — the
 * same FilterSidebar, the same ProductGrid, the same ProductCard, the same
 * breakpoints. Only where the work happens has moved.
 */
export default function ShopFilters({
  products,
  categoryTree,
  sizesByProduct = {},
  facetValues,
  filters,
}: {
  /** Already filtered by the database. */
  products: ProductListing[];
  categoryTree: CategoryNode[];
  /** Sizes for the products on show, for the Size filter. */
  sizesByProduct?: SizesByProduct;
  /** Fabric and colour values across the WHOLE catalogue, not this result. */
  facetValues: { fabrics: string[]; colours: string[] };
  /** The filters this page was rendered for, parsed from the URL. */
  filters: CatalogueFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Marks the moment between a filter being chosen and the server answering, so
  // the results can dim rather than sit there looking like nothing happened.
  const [isPending, startTransition] = useTransition();

  const filterOptions: FilterOptions = {
    categoryGroups: categoryTree.map((parent) => ({
      name: parent.name,
      children: parent.children.map((c) => ({ name: c.name, slug: c.slug })),
    })),
    fabrics: facetValues.fabrics,
    colours: facetValues.colours,
    // Still derived from what is on show: a size filter that offers a label
    // nothing in view has stock in would always return an empty grid.
    sizes: availableSizes(products, sizesByProduct),
  };

  const apply = (next: Filters) => {
    startTransition(() => {
      // scroll: false — reordering the grid under somebody should not also throw
      // them back to the top of the page.
      router.push(catalogueHref(pathname, next), {
        scroll: false,
      });
    });
  };

  return (
    <div className="mt-12 flex flex-col gap-10 lg:flex-row lg:gap-12">
      <button
        onClick={() => setMobileFiltersOpen(true)}
        className="flex items-center gap-2 self-start rounded-full border border-ink/15 px-5 py-2.5 text-sm uppercase tracking-wider text-ink lg:hidden"
      >
        <SlidersHorizontal className="h-4 w-4" /> Filters
      </button>

      <FilterSidebar
        options={filterOptions}
        filters={filters}
        onChange={apply}
        isOpen={mobileFiltersOpen}
        onClose={() => setMobileFiltersOpen(false)}
      />

      <div className="min-w-0 flex-1">
        {/* aria-busy rather than a spinner: the results are already on screen and
            about to be replaced, so the honest signal is that they are stale,
            not that the page is empty. */}
        <div
          aria-busy={isPending}
          className={
            isPending ? "opacity-60 transition-opacity duration-200" : undefined
          }
        >
          {products.length === 0 ? (
            <div className="py-20 text-center">
              <p className="text-sm text-ink/60">
                No pieces match those filters just yet.
              </p>
              {/* A dead end needs a way out. Without this the only escape from an
                  empty result is the browser's back button. */}
              <button
                onClick={() => apply(NO_FILTERS)}
                className="mt-4 text-xs uppercase tracking-wider text-terracotta underline-offset-4 hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <ProductGrid products={products} />
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { Product } from "@/lib/types";
import FilterSidebar, {
  EMPTY_FILTERS,
  type FilterOptions,
  type Filters,
} from "@/components/shop/FilterSidebar";
import ProductGrid from "@/components/shop/ProductGrid";

/**
 * Client-side filtering over a server-fetched product list. The list itself is
 * cached (revalidate) by the /shop server page, so the DB isn't hit per request.
 */
export default function ShopFilters({ products }: { products: Product[] }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const filterOptions: FilterOptions = useMemo(() => {
    const categories = new Set<string>();
    const fabrics = new Set<string>();
    const colours = new Set<string>();
    products.forEach((p) => {
      if (p.category) categories.add(p.category);
      if (p.fabric) fabrics.add(p.fabric);
      if (p.colour) colours.add(p.colour);
    });
    return {
      categories: Array.from(categories).sort(),
      fabrics: Array.from(fabrics).sort(),
      colours: Array.from(colours).sort(),
    };
  }, [products]);

  const filteredProducts = useMemo(
    () =>
      products.filter((p) => {
        if (filters.category && p.category !== filters.category) return false;
        if (filters.fabric && p.fabric !== filters.fabric) return false;
        if (filters.colour && p.colour !== filters.colour) return false;
        if (filters.maxPrice !== null && p.price_inr > filters.maxPrice) return false;
        return true;
      }),
    [products, filters]
  );

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
        onChange={setFilters}
        isOpen={mobileFiltersOpen}
        onClose={() => setMobileFiltersOpen(false)}
      />

      <div className="flex-1">
        {filteredProducts.length === 0 ? (
          <p className="py-20 text-center text-sm text-ink/60">
            No pieces match those filters just yet.
          </p>
        ) : (
          <ProductGrid products={filteredProducts} />
        )}
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { CategoryNode, Product } from "@/lib/types";
import FilterSidebar, {
  EMPTY_FILTERS,
  type FilterOptions,
  type Filters,
} from "@/components/shop/FilterSidebar";
import ProductGrid from "@/components/shop/ProductGrid";
import {
  availableSizes,
  matchesFilters,
  type SizesByProduct,
} from "@/lib/productFilters";

/**
 * Client-side filtering over a server-fetched product list. The list itself is
 * cached (revalidate) by the /shop server page, so the DB isn't hit per request.
 * Category options come from the visible category tree (admin-managed), while
 * fabric/colour options are still derived from the products on show.
 */
export default function ShopFilters({
  products,
  categoryTree,
  sizesByProduct = {},
}: {
  products: Product[];
  categoryTree: CategoryNode[];
  /** Per-product sizes, for the Size filter. Absent means no Size filter. */
  sizesByProduct?: SizesByProduct;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const filterOptions: FilterOptions = useMemo(() => {
    const fabrics = new Set<string>();
    const colours = new Set<string>();
    products.forEach((p) => {
      if (p.fabric) fabrics.add(p.fabric);
      if (p.colour) colours.add(p.colour);
    });
    return {
      categoryGroups: categoryTree.map((parent) => ({
        name: parent.name,
        children: parent.children.map((c) => ({ name: c.name, slug: c.slug })),
      })),
      fabrics: Array.from(fabrics).sort(),
      colours: Array.from(colours).sort(),
      sizes: availableSizes(products, sizesByProduct),
    };
  }, [products, categoryTree, sizesByProduct]);

  const filteredProducts = useMemo(
    () =>
      products.filter((p) => matchesFilters(p, filters, sizesByProduct)),
    [products, filters, sizesByProduct]
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Product } from "@/lib/types";
import FilterSidebar, {
  EMPTY_FILTERS,
  type FilterOptions,
  type Filters,
} from "@/components/shop/FilterSidebar";
import ProductGrid from "@/components/shop/ProductGrid";

export default function ShopPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  useEffect(() => {
    let active = true;

    supabase
      .from("products")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setError(error.message);
        } else {
          setProducts(data ?? []);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const filterOptions: FilterOptions = useMemo(() => {
    const categories = new Set<string>();
    const fabrics = new Set<string>();
    const colours = new Set<string>();

    (products ?? []).forEach((p) => {
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

  const filteredProducts = useMemo(() => {
    if (!products) return null;
    return products.filter((p) => {
      if (filters.category && p.category !== filters.category) return false;
      if (filters.fabric && p.fabric !== filters.fabric) return false;
      if (filters.colour && p.colour !== filters.colour) return false;
      if (filters.maxPrice !== null && p.price_gbp > filters.maxPrice) return false;
      return true;
    });
  }, [products, filters]);

  return (
    <div className="container-wovenne section-padding">
      <div className="text-center">
        <span className="font-script text-2xl text-terracotta">
          The Collection
        </span>
        <h1 className="mt-2 font-heading text-4xl text-ink sm:text-5xl">
          Shop All
        </h1>
      </div>

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
          {error ? (
            <p className="py-20 text-center text-sm text-terracotta-dark">
              Could not load products right now. Please try again shortly.
            </p>
          ) : (
            <ProductGrid products={filteredProducts} />
          )}
        </div>
      </div>
    </div>
  );
}

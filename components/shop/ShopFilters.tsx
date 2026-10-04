"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { CategoryNode, ProductListing } from "@/lib/types";
import type { FilterOptions } from "@/components/shop/FilterSidebar";
import CatalogueListing from "@/components/shop/CatalogueListing";
import { availableSizes, type SizesByProduct } from "@/lib/productFilters";
import { sizeGroupTitle } from "@/lib/catalogueFacets";
import type { PriceSliderRange } from "@/lib/priceSlider";
import { catalogueHref, type CatalogueFilters } from "@/lib/catalogueParams";

/**
 * The shop's controls. It does no filtering and no ordering.
 *
 * The URL is the state. Choosing a filter or a sort navigates; the server reads
 * the search params, asks the database, orders the answer and sends back only
 * what matched. This component turns a change into that navigation and hands
 * the layout to CatalogueListing, which every listing shares.
 */
export default function ShopFilters({
  products,
  total,
  categoryTree,
  sizesByProduct = {},
  facetValues,
  priceRange,
  availability,
  filters,
  sizeScope = null,
}: {
  /** Already filtered by the database and ordered by the page. */
  products: ProductListing[];
  /** The unfiltered catalogue's size, for "8 of 33 products". */
  total: number;
  /** Sections and the sub-categories in them that hold a product. */
  categoryTree: CategoryNode[];
  /** Sizes for the products on show, for the Size filter. */
  sizesByProduct?: SizesByProduct;
  /**
   * Fabric facets and colours across the whole catalogue — or the chosen
   * sub-category — not just this result.
   */
  facetValues: { fabrics: string[]; colours: string[] };
  /** The price slider's range over the same scope, or null if no ceiling narrows it. */
  priceRange: PriceSliderRange | null;
  /**
   * The chosen sub-category's name, or null. Sizes are offered only inside
   * one sub-category — a ring's 6 is not a size of the whole shop.
   */
  sizeScope?: string | null;
  /** Whether "In stock" would narrow the whole catalogue. */
  availability: boolean;
  /** The filters this page was rendered for, parsed from the URL. */
  filters: CatalogueFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // Marks the moment between a change and the server answering, so the results
  // can dim rather than sit there looking like nothing happened.
  const [isPending, startTransition] = useTransition();

  const options: FilterOptions = {
    categoryGroups: categoryTree.map((parent) => ({
      name: parent.name,
      children: parent.children.map((c) => ({ name: c.name, slug: c.slug })),
    })),
    fabrics: facetValues.fabrics,
    colours: facetValues.colours,
    // Only inside one sub-category, and still derived from what is on show: a
    // size filter that offers a label nothing in view has stock in would
    // always return an empty grid.
    sizes: sizeScope ? availableSizes(products, sizesByProduct) : [],
    sizeTitle: sizeGroupTitle(sizeScope),
    priceRange,
    availability,
  };

  const apply = (next: CatalogueFilters) => {
    startTransition(() => {
      // scroll: false — reordering the grid under somebody should not also throw
      // them back to the top of the page.
      router.push(catalogueHref(pathname, next), { scroll: false });
    });
  };

  return (
    <CatalogueListing
      products={products}
      total={total}
      filters={filters}
      options={options}
      onChange={apply}
      pending={isPending}
    />
  );
}

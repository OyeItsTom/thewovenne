"use client";

import { useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/types";
import type { FilterOptions } from "./FilterSidebar";
import CatalogueListing from "./CatalogueListing";
import {
  availableSizes,
  distinctValues,
  matchesFilters,
  type SizesByProduct,
} from "@/lib/productFilters";
import {
  NO_FILTERS,
  catalogueHref,
  parseCatalogueParams,
  type CatalogueFilters,
} from "@/lib/catalogueParams";
import {
  offersAvailability,
  orderForDiscovery,
  usefulPriceSteps,
} from "@/lib/catalogueDiscovery";

/**
 * The listing on a section (/in/women) or sub-category (/in/women/sarees) page.
 *
 * Filtering and ordering happen in the browser over a server-fetched list: a
 * section holds tens of products, not thousands, so a round trip per click
 * would be slower and no more correct. The rules are the shared ones —
 * matchesFilters, orderForDiscovery — so this page and the shop cannot answer
 * the same question differently.
 *
 * THE URL CARRIES THE CHOICE, so a reload or a shared link keeps it. Written
 * with history.replaceState rather than a navigation: these pages are
 * statically generated, and a navigation (or useSearchParams) would make them
 * render per request. Replace, not push — a filter tap is not a page, so Back
 * still leaves the listing as it always has. The first render is always the
 * unfiltered listing, which is what the static HTML and crawlers get; the URL
 * is read once on mount.
 *
 * No category filter here, unlike the shop: you are already inside one, and a
 * section links to its sub-categories directly above this.
 */
export default function CategoryFilters({
  products,
  sizesByProduct,
}: {
  products: Product[];
  sizesByProduct: SizesByProduct;
}) {
  const [filters, setFilters] = useState<CatalogueFilters>(NO_FILTERS);

  useEffect(() => {
    const parsed = parseCatalogueParams(
      Object.fromEntries(new URLSearchParams(window.location.search))
    );
    // A ?category= has no meaning inside a category page; ignore it rather than
    // let it empty the grid.
    setFilters({ ...parsed, category: null });
  }, []);

  const change = (next: CatalogueFilters) => {
    setFilters(next);
    window.history.replaceState(
      window.history.state,
      "",
      catalogueHref(window.location.pathname, next)
    );
  };

  const options: FilterOptions = useMemo(
    () => ({
      categoryGroups: [],
      fabrics: distinctValues(products, (p) => p.fabric),
      colours: distinctValues(products, (p) => p.colour),
      // Empty for sarees, which have no sizes — so the Size filter simply is
      // not rendered, with nothing anywhere naming that category.
      sizes: availableSizes(products, sizesByProduct),
      priceSteps: usefulPriceSteps(products.map((p) => p.price_inr)),
      availability: offersAvailability(products),
    }),
    [products, sizesByProduct]
  );

  const shown = useMemo(
    () =>
      orderForDiscovery(
        products.filter((p) => matchesFilters(p, filters, sizesByProduct)),
        filters.sort
      ),
    [products, filters, sizesByProduct]
  );

  return (
    <CatalogueListing
      products={shown}
      total={products.length}
      filters={filters}
      options={options}
      onChange={change}
    />
  );
}

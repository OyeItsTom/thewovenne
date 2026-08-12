import type { Metadata } from "next";
import {
  getCatalogue,
  getCatalogueCategoryTree,
  getCatalogueFacetValues,
  getCatalogueSizes,
} from "@/lib/storefront";
import { parseCatalogueParams, type RawSearchParams } from "@/lib/catalogueParams";
import ShopFilters from "@/components/shop/ShopFilters";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

/*
 * Reading searchParams makes this render dynamically — that is how App Router
 * works and it is not avoidable while filters live in the URL. The 60s caching
 * this page has always had did not go away, it moved: getCatalogue() caches the
 * QUERY per filter combination. The public category-tree and displayed-size
 * support reads use the same TTL; preview bypasses every one of those caches.
 * See lib/storefront.
 */
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Shop All | THE WOVENNE",
  description:
    "Authentic handloom linen from Kerala — shirts, kurtas, sarees, and home. Woven in India, priced in ₹.",
  openGraph: {
    title: "Shop All | THE WOVENNE",
    description:
      "Authentic handloom linen from Kerala — shirts, kurtas, sarees, and home.",
    images: [DEFAULT_OG_IMAGE],
  },
};

export default async function ShopPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  const filters = parseCatalogueParams(searchParams);

  // THE DATABASE DOES THE FILTERING. What arrives here is the matching products
  // and nothing else, so the page serialises a result rather than a catalogue.
  const [{ products }, categoryTree, facetValues] = await Promise.all([
    getCatalogue(filters),
    getCatalogueCategoryTree(),
    // Across the whole catalogue, not just this result — otherwise filtering to
    // one product would leave one chip and no way back.
    getCatalogueFacetValues(),
  ]);

  // Only for the products actually on show. Previously this was every product
  // in the shop whether or not a size filter was ever touched.
  const sizesByProduct = await getCatalogueSizes(products.map((p) => p.id));

  return (
    <div className="container-wovenne section-padding">
      <div className="text-center">
        <p className="eyebrow">The Collection</p>
        <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
          Shop All
        </h1>
      </div>
      <ShopFilters
        products={products}
        categoryTree={categoryTree}
        sizesByProduct={sizesByProduct}
        facetValues={facetValues}
        filters={filters}
      />
    </div>
  );
}

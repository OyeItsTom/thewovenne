import type { Metadata } from "next";
import {
  getCatalogue,
  getCatalogueCategoryTree,
  getCatalogueFacetValues,
  getCatalogueSizes,
} from "@/lib/storefront";
import { parseCatalogueParams, type RawSearchParams } from "@/lib/catalogueParams";
import ShopFilters from "@/components/shop/ShopFilters";
import { openGraph } from "@/lib/seo";
import { cPath } from "@/lib/country";

/*
 * Reading searchParams makes this render dynamically — that is how App Router
 * works and it is not avoidable while filters live in the URL. The 60s caching
 * this page has always had did not go away, it moved: getCatalogue() caches the
 * QUERY per filter combination. The public category-tree and displayed-size
 * support reads use the same TTL; preview bypasses every one of those caches.
 * See lib/storefront.
 */
export const revalidate = 60;

const TITLE = "Shop All | THE WOVENNE";
/*
 * WHAT IT SAID, AND WHY NONE OF IT COULD STAY: "Authentic handloom linen from
 * Kerala — shirts, kurtas, sarees, and home." There is no linen in the
 * catalogue, Kerala is not the documented origin of what is in it, and three of
 * the four product kinds named — shirts, kurtas, home — are sections with
 * nothing filed under them. A description listing stock the shop does not have
 * is the one kind of snippet that costs more than it earns: it wins the click
 * and loses the visit.
 *
 * What replaces it names only what /in/shop actually lists today.
 */
const DESCRIPTION =
  "Every piece at THE WOVENNE in one place — handloom cotton sarees, clothing and jewellery. Priced in ₹, shipped across India.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  /*
   * THE UNFILTERED CATALOGUE, FOR EVERY FILTERED VIEW OF IT.
   *
   * Static, not per-request, and that is the point: this object is the metadata
   * for /in/shop AND for every ?colour=&fabric=&size=&maxPrice= combination of
   * it, because filters live in the URL rather than in a component. Five
   * dimensions multiply into an unbounded set of URLs that each returned 200,
   * each self-canonicalised, and each carried this same title, description and
   * h1 — a duplicate cluster with no head.
   *
   * Naming the clean path here consolidates every one of them onto the page
   * that should rank. The filters keep working exactly as before; a customer
   * can still send a friend a filtered link and it still means what it says.
   * Only what Google is told to index changes.
   */
  alternates: { canonical: cPath("/shop") },
  openGraph: openGraph({ title: TITLE, description: DESCRIPTION, path: cPath("/shop") }),
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

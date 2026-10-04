import { unstable_cache } from "next/cache";
import { previewCtx } from "./preview";
import { ANON_CTX } from "./readCtx";
import * as products from "./products";
import * as categories from "./categories";
import * as journal from "./journal";
import * as pages from "./pages";
import { getSizesForProducts } from "./sizes";
import { getContent as readContent } from "./content";
import type { SiteContentMap } from "./types";

/**
 * The storefront's reads, preview-aware.
 *
 * Every customer-facing page imports from here rather than from lib/products &
 * co. The underlying functions take a ReadCtx and know nothing about Next; this
 * module is the single place that turns "is this admin previewing?" into that
 * context.
 *
 * SERVER ONLY — it reaches next/headers through lib/preview. Admin client
 * components must keep importing the underlying modules directly, or the build
 * fails with next/headers in the client bundle.
 */

export const getFeaturedProducts = async (limit = 4) =>
  products.getFeaturedProducts(limit, await previewCtx());

export const getAllProducts = async () => products.getAllProducts(await previewCtx());

/**
 * The filtered catalogue, cached per distinct set of filters.
 *
 * WHY A CACHE HAS TO APPEAR HERE. Reading searchParams makes a page render
 * dynamically, which would otherwise turn a statically generated catalogue into
 * a database round trip for every visitor — undoing the 60s revalidate the shop
 * page has always had. Caching the QUERY rather than the page keeps that intent:
 * the render is dynamic, the data is not re-fetched.
 *
 * PREVIEW IS NEVER CACHED, and this is the important line in the file. An admin
 * viewing drafts must not have their view stored and served to customers, and a
 * customer's cached view must not be overwritten by a draft. Preview takes the
 * uncached path every time.
 *
 * Keyed on the filters themselves, so two customers asking the same question
 * share an answer and a different question gets its own.
 *
 * CARDINALITY. The URL parser admits only five named fields, drops empty values,
 * caps text at 80 characters and caps price. The theoretical text combinations
 * are still unbounded, but entries expire after 60 seconds and the deployed
 * data cache is evictable. At a four-product launch catalogue, adding a second
 * validation/cache subsystem would cost more complexity than it removes. Revisit
 * alongside pagination or if cache/storage telemetry shows abuse.
 */
const cachedCatalogue = unstable_cache(
  async (filters: products.CatalogueFilterInput, limit?: number, offset?: number) =>
    products.getCatalogue(filters, { limit, offset }, ANON_CTX),
  ["catalogue"],
  { revalidate: 60, tags: ["catalogue"] }
);

export const getCatalogue = async (
  filters: products.CatalogueFilterInput = {},
  opts: { limit?: number; offset?: number } = {}
) => {
  const ctx = await previewCtx();
  if (ctx.preview) return products.getCatalogue(filters, opts, ctx);
  return cachedCatalogue(filters, opts.limit, opts.offset);
};

const cachedFacets = unstable_cache(
  async () => products.getCatalogueFacetValues(ANON_CTX),
  ["catalogue-facets"],
  { revalidate: 60, tags: ["catalogue"] }
);

export const getCatalogueFacetValues = async () => {
  const ctx = await previewCtx();
  if (ctx.preview) return products.getCatalogueFacetValues(ctx);
  return cachedFacets();
};

/**
 * The shop's Category filter: sections, narrowed to the sub-categories that
 * hold a published, active product.
 *
 * getNavCategoryTree, not getVisibleCategoryTree, and that is the fix. The
 * header already used the nav tree, so it never offered Shirts or Dresses; the
 * shop's filter used the merely-visible tree and offered all fourteen, ten of
 * them empty. One rule now answers "is there anything to browse here?" for the
 * header, the shop and the section pages. Routes, robots and the sitemap do not
 * read this and are unchanged.
 *
 * Stock level is ignored by that rule on purpose — a sold-out shelf is still a
 * shelf. It fails closed (an error gives []), which here only hides the filter.
 */
const cachedCategoryTree = unstable_cache(
  async () => categories.getNavCategoryTree(ANON_CTX),
  ["catalogue-eligible-category-tree"],
  { revalidate: 60, tags: ["catalogue"] }
);

/** Public catalogue support reads share its TTL; preview remains request-local. */
export const getCatalogueCategoryTree = async () => {
  const ctx = await previewCtx();
  if (ctx.preview) return categories.getNavCategoryTree(ctx);
  return cachedCategoryTree();
};

const cachedCatalogueSizes = unstable_cache(
  async (productIds: string[]) => {
    const sizes = await getSizesForProducts(productIds, ANON_CTX.client);
    return Object.fromEntries(sizes);
  },
  ["catalogue-product-sizes"],
  { revalidate: 60, tags: ["catalogue"] }
);

export const getCatalogueSizes = async (productIds: string[]) => {
  const ctx = await previewCtx();
  if (ctx.preview) {
    return Object.fromEntries(await getSizesForProducts(productIds, ctx.client));
  }
  return cachedCatalogueSizes(productIds);
};

/**
 * Heritage, craft and care for one piece — preview-aware, so an admin editing
 * the notes sees the draft on the real product page before publishing.
 */
export const getBrandKnowledge = async (ref: { slug?: string; productId?: string }) =>
  products.getBrandKnowledge(ref, await previewCtx());

export const getProductsByCollection = async (collection: string) =>
  products.getProductsByCollection(collection, await previewCtx());

export const getProductsByCategoryIds = async (ids: string[]) =>
  products.getProductsByCategoryIds(ids, await previewCtx());

export const getProductBySlug = async (slug: string) =>
  products.getProductBySlug(slug, await previewCtx());

export const getRelatedProducts = async (
  categoryId: string | null,
  excludeSlug: string,
  limit = 4
) => products.getRelatedProducts(categoryId, excludeSlug, limit, await previewCtx());

export const getVisibleCategoryTree = async () =>
  categories.getVisibleCategoryTree(await previewCtx());

export const getNavCategoryTree = async () =>
  categories.getNavCategoryTree(await previewCtx());

export const getPublishedPosts = async () => journal.getPublishedPosts(await previewCtx());

export const getPostBySlug = async (slug: string) =>
  journal.getPostBySlug(slug, await previewCtx());

export const getPublishedPages = async () => pages.getPublishedPages(await previewCtx());

export const getPageBySlug = async (slug: string) =>
  pages.getPageBySlug(slug, await previewCtx());

export const getContent = async <K extends keyof SiteContentMap>(key: K) =>
  readContent(key, await previewCtx());

// Build-time only, so preview never applies.
export const getCollectionSlugs = products.getCollectionSlugs;
export const getProductImages = products.getProductImages;

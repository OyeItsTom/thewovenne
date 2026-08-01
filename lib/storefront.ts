import { previewCtx } from "./preview";
import * as products from "./products";
import * as categories from "./categories";
import * as journal from "./journal";
import * as pages from "./pages";
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

export const getFeaturedProducts = (limit = 4) =>
  products.getFeaturedProducts(limit, previewCtx());

export const getAllProducts = () => products.getAllProducts(previewCtx());

export const getProductsByCollection = (collection: string) =>
  products.getProductsByCollection(collection, previewCtx());

export const getProductsByCategoryIds = (ids: string[]) =>
  products.getProductsByCategoryIds(ids, previewCtx());

export const getProductBySlug = (slug: string) =>
  products.getProductBySlug(slug, previewCtx());

export const getRelatedProducts = (
  categoryId: string | null,
  excludeSlug: string,
  limit = 4
) => products.getRelatedProducts(categoryId, excludeSlug, limit, previewCtx());

export const getVisibleCategoryTree = () =>
  categories.getVisibleCategoryTree(previewCtx());

export const getNavCategoryTree = () =>
  categories.getNavCategoryTree(previewCtx());

export const getPublishedPosts = () => journal.getPublishedPosts(previewCtx());

export const getPostBySlug = (slug: string) =>
  journal.getPostBySlug(slug, previewCtx());

export const getPublishedPages = () => pages.getPublishedPages(previewCtx());

export const getPageBySlug = (slug: string) =>
  pages.getPageBySlug(slug, previewCtx());

export const getContent = <K extends keyof SiteContentMap>(key: K) =>
  readContent(key, previewCtx());

// Build-time only, so preview never applies.
export const getCollectionSlugs = products.getCollectionSlugs;
export const getProductImages = products.getProductImages;

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

export const getFeaturedProducts = async (limit = 4) =>
  products.getFeaturedProducts(limit, await previewCtx());

export const getAllProducts = async () => products.getAllProducts(await previewCtx());

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

import { cPath } from "./country";
import type { Product } from "./types";

/**
 * Where a product lives.
 *
 * Hierarchical — /women/sarees/kerala-kasavu — so the URL says what the page is
 * and search engines see the catalogue's shape rather than a flat list.
 *
 * Country-prefixed via cPath, so every product link carries the market from
 * day one and adding /uk later needs no URL change.
 *
 * Falls back to the old flat path when the category hierarchy is incomplete
 * (no category, or a category whose parent is not published). That path still
 * resolves and redirects, so a product is never unreachable just because its
 * filing is half-finished.
 */
export function productHref(
  product: Pick<Product, "slug" | "category_slug" | "category_parent_slug">
): string {
  const { category_parent_slug: parent, category_slug: child, slug } = product;
  if (!parent || !child) return cPath(`/product/${slug}`);
  return cPath(`/${parent}/${child}/${slug}`);
}

/** Where a sub-category lives, e.g. /in/women/sarees. */
export function categoryHref(parentSlug: string, childSlug: string): string {
  return cPath(`/${parentSlug}/${childSlug}`);
}

/**
 * Where a ROOT-LEVEL slug lives — /in/women, /in/policies.
 *
 * ONE FUNCTION BECAUSE ONE ROUTE SERVES BOTH. app/(storefront)/in/[slug] is a
 * single dynamic segment resolving to either a category section or a content
 * page, because Next allows only one dynamic segment at a given level. Their
 * URLs are built identically, so building them in one named place is what lets
 * the canonical be asserted without a database standing behind it.
 *
 * Exists for the same reason categoryHref does: the sub-category canonical was
 * once written out by hand as `/${parent.slug}/${child.slug}`, lost the market
 * prefix, and pointed at a redirect for as long as that page existed. A path
 * spelled out at the call site is a path that can silently forget where it
 * lives.
 */
export function rootSlugHref(slug: string): string {
  return cPath(`/${slug}`);
}

/** Where a journal post lives, e.g. /in/journal/why-does-linen-crease. */
export function journalHref(slug: string): string {
  return cPath(`/journal/${slug}`);
}

/**
 * Where a seasonal collection lives, e.g. /in/collection/onam-edit.
 *
 * The slug is not an entity anywhere — a collection is a free-text value on
 * products.collection, so there is no row to resolve one against. What makes
 * the URL honest is the page itself: it calls notFound() when the scoped
 * product query comes back empty, and Next then replaces this route's metadata
 * with the not-found boundary's, which is noindex. So a canonical here can only
 * ever appear on a page that found products to show.
 */
export function collectionHref(slug: string): string {
  return cPath(`/collection/${slug}`);
}

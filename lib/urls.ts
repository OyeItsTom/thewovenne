import type { Product } from "./types";

/**
 * Where a product lives.
 *
 * Hierarchical — /women/sarees/kerala-kasavu — so the URL says what the page is
 * and search engines see the catalogue's shape rather than a flat list.
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
  if (!parent || !child) return `/product/${slug}`;
  return `/${parent}/${child}/${slug}`;
}

/** Where a sub-category lives, e.g. /women/sarees. */
export function categoryHref(parentSlug: string, childSlug: string): string {
  return `/${parentSlug}/${childSlug}`;
}

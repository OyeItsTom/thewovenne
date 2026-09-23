import type { MetadataRoute } from "next";
import { getAllProducts } from "@/lib/products";
import { getVisibleCategoryTree } from "@/lib/categories";
import { productHref } from "@/lib/urls";
import { getPublishedPosts } from "@/lib/journal";
import { getPublishedPages } from "@/lib/pages";
import { buildSitemap } from "@/lib/sitemapRoutes";

const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const revalidate = 3600;

/**
 * This route FETCHES. What is worth submitting, and what date may honestly be
 * claimed for it, is decided in lib/sitemapRoutes — pure, and testable without
 * a database (scripts/seo-indexing.test.ts).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [products, posts, pages, tree] = await Promise.all([
    getAllProducts(),
    getPublishedPosts(),
    getPublishedPages(),
    getVisibleCategoryTree(),
  ]);

  return buildSitemap({
    base,
    // productHref stays the single source of product URLs, so a sitemap entry
    // and the page's own canonical cannot disagree.
    products: products.map((product) => ({
      href: productHref(product),
      created_at: product.created_at,
      category_slug: product.category_slug,
      category_parent_slug: product.category_parent_slug,
      collection: product.collection,
    })),
    categories: tree,
    pages,
    posts,
  });
}

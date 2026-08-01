import type { MetadataRoute } from "next";
import { getAllProducts } from "@/lib/products";
import { getVisibleCategoryTree } from "@/lib/categories";
import { productHref } from "@/lib/urls";
import { getPublishedPosts } from "@/lib/journal";
import { getPublishedPages } from "@/lib/pages";

const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [products, posts, pages, tree] = await Promise.all([
    getAllProducts(),
    getPublishedPosts(),
    getPublishedPages(),
    getVisibleCategoryTree(),
  ]);

  const staticRoutes: MetadataRoute.Sitemap = [
    "",
    "/shop",
    "/journal",
    "/cart",
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: path === "" ? 1 : 0.7,
  }));

  const productRoutes: MetadataRoute.Sitemap = products.map((p) => ({
    url: `${base}${productHref(p)}`,
    lastModified: new Date(p.created_at),
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  const journalRoutes: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${base}/journal/${post.slug}`,
    lastModified: new Date(post.created_at),
    changeFrequency: "monthly",
    priority: 0.4,
  }));

  // Content pages are real URLs and belong in the sitemap like anything else.
  const pageRoutes: MetadataRoute.Sitemap = pages.map((page) => ({
    url: `${base}/${page.slug}`,
    lastModified: new Date(),
    changeFrequency: "monthly",
    priority: 0.5,
  }));

  // Category and sub-category listings are real pages, and they are what the
  // product URLs hang off — a sitemap without them describes half the shop.
  const categoryRoutes: MetadataRoute.Sitemap = tree.flatMap((parent) => [
    {
      url: `${base}/${parent.slug}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    },
    ...parent.children.map((child) => ({
      url: `${base}/${parent.slug}/${child.slug}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ]);

  return [
    ...staticRoutes,
    ...categoryRoutes,
    ...pageRoutes,
    ...productRoutes,
    ...journalRoutes,
  ];
}

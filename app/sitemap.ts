import type { MetadataRoute } from "next";
import { getAllProducts } from "@/lib/products";
import { getPublishedPosts } from "@/lib/journal";
import { getPublishedPages } from "@/lib/pages";

const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [products, posts, pages] = await Promise.all([
    getAllProducts(),
    getPublishedPosts(),
    getPublishedPages(),
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
    url: `${base}/product/${p.slug}`,
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

  return [...staticRoutes, ...pageRoutes, ...productRoutes, ...journalRoutes];
}

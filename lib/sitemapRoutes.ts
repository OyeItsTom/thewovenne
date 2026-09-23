import { cPath } from "./country";

/**
 * What belongs in the sitemap, as pure functions.
 *
 * WHY THIS IS NOT IN app/sitemap.ts. Everything here is a judgement about what
 * we ask Google to crawl, and that is exactly the kind of decision that should
 * be readable on its own and testable without a database or a build — the same
 * reason lib/footer.ts exists. app/sitemap.ts fetches; this decides.
 *
 * NO REACT, NO NEXT, NO DATABASE.
 *
 * TWO RULES RUN THROUGH ALL OF IT.
 *
 * 1. EVERY SUBMITTED URL MUST SERVE 200 AND BE WORTH OPENING. Not a redirect,
 *    not a 404, and not a page that renders "this collection is still on the
 *    loom". A sitemap is a set of claims about pages worth indexing; a claim
 *    that turns out to be empty is answered with "Crawled – currently not
 *    indexed", and enough of those shape how the whole property is judged.
 *
 * 2. NO INVENTED DATES. lastModified is OMITTED wherever nothing stored means
 *    "this page changed". The previous version sent `new Date()` for categories
 *    and content pages, which told Google the entire site had changed an hour
 *    ago — every hour, forever. That is a claim a crawler learns to discount,
 *    and once discounted it is discounted for the honest dates on products and
 *    journal posts too. An absent date costs nothing; a false one costs the
 *    credibility of the true ones.
 */

export type ChangeFrequency =
  | "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

/** Structurally compatible with Next's MetadataRoute.Sitemap entries. */
export interface SitemapEntry {
  url: string;
  lastModified?: Date;
  changeFrequency?: ChangeFrequency;
  priority?: number;
}

/** A product, as the sitemap needs to see it. */
export interface SitemapProduct {
  /** Its canonical path, from productHref() — the one source of product URLs. */
  href: string;
  created_at: string;
  /** The sub-category it is filed under, or null when its filing is incomplete. */
  category_slug: string | null;
  category_parent_slug: string | null;
  /** Seasonal campaign slug, or null when it is not in one. */
  collection: string | null;
}

/** The visible category tree — every visible parent, empty ones included. */
export interface SitemapCategory {
  slug: string;
  children: { slug: string }[];
}

export interface SitemapPage {
  slug: string;
  /** When this version went live. Null on a draft or an unpublished row. */
  published_at: string | null;
}

export interface SitemapPost {
  slug: string;
  created_at: string;
}

/**
 * The fixed storefront routes.
 *
 * /cart IS DELIBERATELY ABSENT, and its absence is the point. It was submitted
 * here until now: a per-visitor utility page, empty for a crawler, carrying the
 * root layout's title — so the sitemap was actively asking Google to index a
 * second page claiming to be the homepage. The ROUTE is untouched and still
 * links normally; it is simply no longer advertised. /checkout, /search,
 * /account and /login were never here and still are not.
 *
 * /customer-style IS newly here. It is public, cached, linked from the header
 * and the footer, and was the one real content route the sitemap never named.
 */
const STATIC_ROUTES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/shop", priority: 0.7 },
  { path: "/journal", priority: 0.7 },
  { path: "/customer-style", priority: 0.6 },
];

/**
 * A stored timestamp, or nothing at all.
 *
 * Returns undefined rather than an Invalid Date for a malformed value: one bad
 * row should drop its own date, not emit `<lastmod>Invalid Date</lastmod>` and
 * invalidate the whole file.
 */
export function storedDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The sub-categories that actually hold a product, as "parent/child".
 *
 * DERIVED FROM THE PRODUCTS THIS SITEMAP IS ALREADY SUBMITTING, rather than
 * from a second query of its own. That is what makes the answer correct rather
 * than merely close: a sub-category is worth submitting exactly when a product
 * URL for it appears in this same file, and the only set that guarantees is
 * this one. getNavCategoryTree() answers a similar question for the navigation
 * bar, but it asks product_versions directly, so its answer can drift from the
 * catalogue read the sitemap and the category pages actually render from.
 */
export function stockedChildKeys(products: SitemapProduct[]): Set<string> {
  const keys = new Set<string>();
  for (const product of products) {
    const { category_parent_slug: parent, category_slug: child } = product;
    if (parent && child) keys.add(`${parent}/${child}`);
  }
  return keys;
}

/**
 * Seasonal collections with at least one product, from the same set.
 *
 * Not getCollectionSlugs(): that helper reads every published active product
 * WITHOUT narrowing to visible categories, while /in/collection/[slug] calls
 * notFound() when the visible-scoped query comes back empty. So a collection
 * whose products all sit under a hidden category would be submitted here and
 * 404 on arrival. Deriving it from the scoped set cannot produce that URL.
 *
 * Sorted so the file's ordering is stable between generations.
 */
export function collectionSlugs(products: SitemapProduct[]): string[] {
  const slugs = new Set<string>();
  for (const product of products) {
    if (product.collection) slugs.add(product.collection);
  }
  return [...slugs].sort();
}

export interface SitemapInput {
  /** Origin, no trailing slash. */
  base: string;
  products: SitemapProduct[];
  /** The full visible tree. Empty sections are filtered out here, not by the caller. */
  categories: SitemapCategory[];
  pages: SitemapPage[];
  posts: SitemapPost[];
}

export function buildSitemap({
  base,
  products,
  categories,
  pages,
  posts,
}: SitemapInput): SitemapEntry[] {
  const origin = base.replace(/\/+$/, "");
  // Every entry is country-prefixed. A sitemap listing the bare paths would
  // advertise URLs that only 308 elsewhere — telling a crawler to spend its
  // budget on redirects instead of pages.
  const at = (path: string) => `${origin}${cPath(path)}`;

  const staticRoutes: SitemapEntry[] = STATIC_ROUTES.map(({ path, priority }) => ({
    url: at(path),
    changeFrequency: "weekly",
    priority,
  }));

  // Sub-categories that hold nothing render "still on the loom". They stay
  // crawlable and linked; they are just not submitted as though they were
  // somewhere worth arriving. A parent follows its children: its own page lists
  // its children's products and nothing else, so a parent with no stocked child
  // is just as empty.
  const stocked = stockedChildKeys(products);
  const categoryRoutes: SitemapEntry[] = categories.flatMap((parent) => {
    const children = parent.children.filter((child) =>
      stocked.has(`${parent.slug}/${child.slug}`)
    );
    if (children.length === 0) return [];
    return [
      { url: at(`/${parent.slug}`), changeFrequency: "weekly" as const, priority: 0.8 },
      ...children.map((child) => ({
        url: at(`/${parent.slug}/${child.slug}`),
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
    ];
  });

  // published_at is when this version went live, which is precisely when the
  // page last changed. Absent on a row that has never been published through
  // the queue, and then the date is simply left off.
  const pageRoutes: SitemapEntry[] = pages.map((page) => ({
    url: at(`/${page.slug}`),
    lastModified: storedDate(page.published_at),
    changeFrequency: "monthly",
    priority: 0.5,
  }));

  const collectionRoutes: SitemapEntry[] = collectionSlugs(products).map((slug) => ({
    url: at(`/collection/${slug}`),
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  const productRoutes: SitemapEntry[] = products.map((product) => ({
    url: `${origin}${product.href}`,
    lastModified: storedDate(product.created_at),
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  const journalRoutes: SitemapEntry[] = posts.map((post) => ({
    url: at(`/journal/${post.slug}`),
    lastModified: storedDate(post.created_at),
    changeFrequency: "monthly",
    priority: 0.4,
  }));

  return [
    ...staticRoutes,
    ...categoryRoutes,
    ...pageRoutes,
    ...collectionRoutes,
    ...productRoutes,
    ...journalRoutes,
  ];
}

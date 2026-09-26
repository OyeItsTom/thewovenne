import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getNavCategoryTree, getVisibleCategoryTree } from "@/lib/storefront";
import { getProductsByCategoryIds } from "@/lib/storefront";
import { getPageBySlug, getPublishedPages } from "@/lib/storefront";
import ProductGrid from "@/components/shop/ProductGrid";
import PageBlocks from "@/components/page/PageBlocks";
import { openGraph } from "@/lib/seo";
import { cPath } from "@/lib/country";
import { rootSlugHref } from "@/lib/urls";
import {
  categoryDescription,
  categoryTitle,
  emptyCategoryRobots,
  metaDescription,
  stockedChildrenOf,
} from "@/lib/metadata";

/**
 * Root-level slugs: a category section (/men, /women) or a content page
 * (/about, /faq). Both live in this one route because Next allows only a
 * single dynamic segment at a given level — two would conflict.
 *
 * Static routes still win, so /shop, /cart, /journal, /admin, /product/* and
 * /api/* are unaffected.
 */
export const revalidate = 60;

// A new top-level section works the moment it is published, without waiting
// for a deploy. This was false, to fix a 404 that rendered an EMPTY server body
// — this route matches every single-segment path, so every mistyped URL went
// through its notFound(). Restricting it to build-time slugs fixed that, but
// made adding a section require a redeploy: /jewellery 404d while
// /jewellery/chain worked, because the child route never had the restriction.
//
// Re-verified below that a miss now renders a full not-found page, so the
// restriction is buying nothing and costing a deploy per section.
export const dynamicParams = true;

export async function generateStaticParams() {
  const [tree, pages] = await Promise.all([
    getVisibleCategoryTree(),
    getPublishedPages(),
  ]);
  return [
    ...tree.map((parent) => ({ slug: parent.slug })),
    ...pages.map((page) => ({ slug: page.slug })),
  ];
}

async function resolve(slug: string) {
  const [tree, page] = await Promise.all([
    getVisibleCategoryTree(),
    getPageBySlug(slug),
  ]);
  return { category: tree.find((p) => p.slug === slug) ?? null, page };
}

/**
 * The sub-categories under this section that hold a product, or null when the
 * catalogue could not be read.
 *
 * THE SAME AUTHORITY THE NAVIGATION USES. getNavCategoryTree() is the visible
 * tree narrowed to children with at least one active product — one small read
 * of category_id, not a fetch of every product — and it is already what decides
 * whether this section appears in the header at all. Deriving the description
 * and the robots directive from it keeps three answers to "is there anything
 * here?" in step: the nav, the sitemap and this tag. A hard-coded list of the
 * ten currently-empty sub-categories would be a fourth, and would be wrong the
 * first time one of them is stocked.
 *
 * stockedChildrenOf() is what separates "nothing is filed here" from "nobody
 * could say", which matters because only one of those may produce a noindex.
 */
async function stockedChildren(slug: string) {
  return stockedChildrenOf(await getNavCategoryTree(), slug);
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const { category, page } = await resolve(params.slug);

  if (category) {
    const stocked = await stockedChildren(category.slug);
    const input = {
      parent: { slug: category.slug, name: category.name },
      stockedChildren: (stocked ?? []).map((child) => child.name),
    };
    const title = categoryTitle(input);
    const description = categoryDescription(input);
    return {
      title,
      description,
      // Built from the slug that RESOLVED, not the one that was requested, so
      // the canonical can only ever name the section actually being served.
      // SPELLED OUT AT BOTH CALL SITES rather than hoisted into a local: the
      // shape of this line is what scripts/seo-canonical.test.ts reads to prove
      // no canonical anywhere is a hand-written path. A variable would hide it.
      alternates: { canonical: rootSlugHref(category.slug) },
      robots: emptyCategoryRobots(stocked),
      openGraph: openGraph({
        title,
        description,
        path: rootSlugHref(category.slug),
      }),
    };
  }

  if (page) {
    const title = `${page.title} | THE WOVENNE`;
    // Through the same collapse-and-truncate the product and journal routes
    // use: `intro` is a paragraph, and a paragraph pasted into a meta
    // description arrives with its line breaks in it.
    const description =
      metaDescription(page.meta_description) ?? metaDescription(page.intro);
    return {
      title,
      description,
      // Every content page gets one the moment it is published — /policies and
      // /privacy-policy today, /contact and /shipping whenever they are
      // written. Nothing to remember per page, because pages are rows.
      alternates: { canonical: rootSlugHref(page.slug) },
      openGraph: openGraph({ title, description, path: rootSlugHref(page.slug) }),
    };
  }

  return {};
}

export default async function SlugPage({
  params,
}: {
  params: { slug: string };
}) {
  const { category, page } = await resolve(params.slug);

  if (category) {
    const products = await getProductsByCategoryIds(
      category.children.map((c) => c.id)
    );

    return (
      <div className="container-wovenne section-padding">
        <div className="text-center">
          <p className="eyebrow">The Collection</p>
          <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
            {category.name}
          </h1>
        </div>

        {category.children.length > 1 && (
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            {category.children.map((child) => (
              <Link
                key={child.id}
                href={cPath(`/${category.slug}/${child.slug}`)}
                className="rounded-full border border-ink/15 px-4 py-2 text-xs uppercase tracking-widest text-ink/70 transition-colors hover:border-terracotta hover:text-terracotta"
              >
                {child.name}
              </Link>
            ))}
          </div>
        )}

        <div className="mt-12">
          {products.length === 0 ? (
            <p className="py-20 text-center text-sm text-ink/60">
              This collection is still on the loom. Please check back soon.
            </p>
          ) : (
            <ProductGrid products={products} />
          )}
        </div>
      </div>
    );
  }

  if (page) {
    return (
      <div className="container-wovenne section-padding">
        <div className="mx-auto max-w-prose text-center">
          <h1 className="font-heading text-display-sm text-ink md:text-display-md">
            {page.title}
          </h1>
          {page.intro && (
            <p className="mt-6 text-base leading-relaxed text-ink/70">
              {page.intro}
            </p>
          )}
        </div>

        <div className="mt-14">
          <PageBlocks blocks={page.body} />
        </div>
      </div>
    );
  }

  notFound();
}

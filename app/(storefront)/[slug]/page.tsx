import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getVisibleCategoryTree } from "@/lib/storefront";
import { getProductsByCategoryIds } from "@/lib/storefront";
import { getPageBySlug, getPublishedPages } from "@/lib/storefront";
import ProductGrid from "@/components/shop/ProductGrid";
import PageBlocks from "@/components/page/PageBlocks";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

/**
 * Root-level slugs: a category section (/men, /women) or a content page
 * (/about, /faq). Both live in this one route because Next allows only a
 * single dynamic segment at a given level — two would conflict.
 *
 * Static routes still win, so /shop, /cart, /journal, /admin, /product/* and
 * /api/* are unaffected.
 */
export const revalidate = 60;

// Only slugs from generateStaticParams are served. Anything else 404s through
// the normal not-found path — this route's own notFound() emits an empty
// server body, which a crawler reads as a blank page.
//
// The cost: a NEW section or page needs a deploy before its URL exists.
// EDITING an existing one is live within the revalidate window, which is the
// common case by far.
export const dynamicParams = false;

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

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const { category, page } = await resolve(params.slug);

  if (category) {
    const title = `${category.name} | THE WOVENNE`;
    const description = `Handloom linen for ${category.name.toLowerCase()} — woven in Kerala, sent direct from the loom.`;
    return {
      title,
      description,
      openGraph: { title, description, images: [DEFAULT_OG_IMAGE] },
    };
  }

  if (page) {
    const title = `${page.title} | THE WOVENNE`;
    const description = page.meta_description ?? page.intro ?? undefined;
    return {
      title,
      description,
      openGraph: { title, description, images: [DEFAULT_OG_IMAGE] },
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
                href={`/shop?category=${child.slug}`}
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

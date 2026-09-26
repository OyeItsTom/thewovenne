import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getNavCategoryTree,
  getVisibleCategoryTree,
  getProductsByCategoryIds,
} from "@/lib/storefront";
import CategoryFilters from "@/components/shop/CategoryFilters";
import { getSizesForProducts } from "@/lib/sizes";
import { openGraph } from "@/lib/seo";
import { cPath } from "@/lib/country";
import { categoryHref } from "@/lib/urls";
import {
  categoryDescription,
  categoryTitle,
  emptyCategoryRobots,
  stockedChildrenOf,
  stockedSelf,
} from "@/lib/metadata";
import JsonLd from "@/components/seo/JsonLd";
import { breadcrumbNode } from "@/lib/structuredData";

/**
 * A sub-category listing, e.g. /women/sarees.
 *
 * The middle segment of a product URL has to be a real page — a URL whose
 * parent 404s reads as broken to both visitors and crawlers, and breadcrumbs
 * need somewhere to point.
 */
export const revalidate = 60;

// New sub-categories appear without a deploy. Safe here because the route is
// two segments deep and cannot swallow unrelated paths, and a miss renders the
// normal not-found page rather than an empty body.
export const dynamicParams = true;

export async function generateStaticParams() {
  const tree = await getVisibleCategoryTree();
  return tree.flatMap((parent) =>
    parent.children.map((child) => ({ slug: parent.slug, child: child.slug }))
  );
}

async function resolve(parentSlug: string, childSlug: string) {
  const tree = await getVisibleCategoryTree();
  const parent = tree.find((p) => p.slug === parentSlug);
  const child = parent?.children.find((c) => c.slug === childSlug);
  return { parent, child };
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string; child: string };
}): Promise<Metadata> {
  const { parent, child } = await resolve(params.slug, params.child);
  if (!parent || !child) return {};

  /*
   * TITLE AND DESCRIPTION ARE BUILT, NOT TEMPLATED. What was here put "Handloom
   * linen {child} — woven in Kerala" on every sub-category including the
   * jewellery ones, and titled them "{child} for {parent}" whatever the parent
   * was — which reads correctly as "Rings for Jewellery" and means nothing. Both
   * decisions now live in lib/metadata, where they can be read and tested
   * without a database.
   *
   * ONE EXTRA READ, AND IT DECIDES ONE THING: whether this page may be indexed
   * while it is empty. Ten of the fourteen visible sub-categories are in that
   * state today; every one of the three parent sections holds something, so no
   * section landing page is affected.
   *
   * Through getNavCategoryTree() rather than re-fetching this child's products,
   * which is the same authority the parent section and the header use — one
   * small read of category_id instead of a second full product fetch beside the
   * one the page body already does. stockedChildrenOf() separates "nothing is
   * filed here" from "the catalogue could not be read"; only the first may
   * produce a noindex. See lib/metadata.
   */
  const stocked = stockedSelf(
    stockedChildrenOf(await getNavCategoryTree(), parent.slug),
    child.slug
  );
  const input = {
    parent: { slug: parent.slug, name: parent.name },
    child: { slug: child.slug, name: child.name },
  };
  const title = categoryTitle(input);
  const description = categoryDescription(input);
  return {
    title,
    description,
    robots: emptyCategoryRobots(stocked),
    // THROUGH categoryHref, WHICH CARRIES THE MARKET PREFIX. Written by hand
    // this read `/${parent.slug}/${child.slug}` and metadataBase resolved it to
    // https://www.thewovenne.com/women/sarees — a URL that only 308s back to
    // this page. A canonical pointing at a redirect is the one tag a page
    // cannot afford to get wrong: it is the whole of what it tells Google about
    // which URL counts, and it was naming an address that never serves a page.
    // The product routes have always used a helper for exactly this reason.
    alternates: { canonical: categoryHref(parent.slug, child.slug) },
    openGraph: openGraph({
      title,
      description,
      path: categoryHref(parent.slug, child.slug),
    }),
  };
}

export default async function SubCategoryPage({
  params,
}: {
  params: { slug: string; child: string };
}) {
  const { parent, child } = await resolve(params.slug, params.child);
  if (!parent || !child) notFound();

  const products = await getProductsByCategoryIds([child.id]);
  // One query for every product's sizes rather than one per product.
  const sizeMap = await getSizesForProducts(products.map((p) => p.id));
  const sizesByProduct = Object.fromEntries(sizeMap);

  return (
    <div className="container-wovenne section-padding">
      {/* Mirrors the visible trail immediately below it, two levels deep and
          starting at the section — the page has no Home crumb, so neither does
          this. */}
      <JsonLd
        data={breadcrumbNode([
          { name: parent.name, path: `/${parent.slug}` },
          { name: child.name },
        ])}
      />
      <nav aria-label="Breadcrumb" className="text-xs text-ink/50">
        <Link href={cPath(`/${parent.slug}`)} className="hover:text-terracotta">
          {parent.name}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink/70">{child.name}</span>
      </nav>

      <div className="mt-8 text-center">
        <p className="eyebrow">{parent.name}</p>
        <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
          {child.name}
        </h1>
      </div>

      <div className="mt-12">
        {products.length === 0 ? (
          <p className="py-20 text-center text-sm text-ink/60">
            This collection is still on the loom. Please check back soon.
          </p>
        ) : (
          <CategoryFilters products={products} sizesByProduct={sizesByProduct} />
        )}
      </div>
    </div>
  );
}

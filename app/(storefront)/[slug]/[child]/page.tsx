import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getVisibleCategoryTree,
  getProductsByCategoryIds,
} from "@/lib/storefront";
import CategoryFilters from "@/components/shop/CategoryFilters";
import { getSizesForProducts } from "@/lib/sizes";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

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

  const title = `${child.name} for ${parent.name} | THE WOVENNE`;
  const description = `Handloom linen ${child.name.toLowerCase()} — woven in Kerala, sent direct from the loom.`;
  return {
    title,
    description,
    alternates: { canonical: `/${parent.slug}/${child.slug}` },
    openGraph: { title, description, images: [DEFAULT_OG_IMAGE] },
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
      <nav aria-label="Breadcrumb" className="text-xs text-ink/50">
        <Link href={`/${parent.slug}`} className="hover:text-terracotta">
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

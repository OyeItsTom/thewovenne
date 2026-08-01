import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCollectionSlugs, getProductsByCollection,  } from "@/lib/storefront";
import { getContent } from "@/lib/storefront";
import ProductGrid from "@/components/shop/ProductGrid";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

/**
 * A seasonal collection, e.g. /collection/onam-edit — where the homepage
 * seasonal link points. Just a filtered product listing, reusing ProductGrid,
 * so a campaign page looks like the rest of the shop rather than a microsite.
 */
export const revalidate = 60;

// Unlike the root-level [slug] route, this one is namespaced under /collection,
// so it cannot swallow unrelated paths. Allowing params beyond the prerendered
// list means tagging products into a NEW collection makes its page work within
// the revalidate window, with no deploy — which is the whole point of being able
// to run a campaign from the admin.
export const dynamicParams = true;

export async function generateStaticParams() {
  const slugs = await getCollectionSlugs();
  return slugs.map((slug) => ({ slug }));
}

/** Title the page after the campaign when the heading is set, else the slug. */
function titleise(slug: string) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const name = titleise(params.slug);
  const title = `${name} | THE WOVENNE`;
  const description = `${name} — a seasonal selection of handloom linen, woven in Kerala.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [DEFAULT_OG_IMAGE] },
  };
}

export default async function CollectionPage({
  params,
}: {
  params: { slug: string };
}) {
  const [products, seasonal] = await Promise.all([
    getProductsByCollection(params.slug),
    getContent("seasonal_edit"),
  ]);

  if (products.length === 0) notFound();

  // Reuse the campaign's own wording when this is the collection the homepage
  // is currently pointing at, so the two read as one piece rather than two.
  const isCurrent =
    seasonal.enabled && seasonal.link_href === `/collection/${params.slug}`;

  return (
    <div className="container-wovenne section-padding">
      <div className="text-center">
        <p className="eyebrow">
          {isCurrent && seasonal.eyebrow?.trim()
            ? seasonal.eyebrow
            : "The Collection"}
        </p>
        <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
          {isCurrent && seasonal.heading?.trim()
            ? seasonal.heading
            : titleise(params.slug)}
        </h1>
        {isCurrent && seasonal.body?.trim() && (
          <p className="mx-auto mt-6 max-w-prose text-base leading-relaxed text-ink/70">
            {seasonal.body}
          </p>
        )}
      </div>

      <div className="mt-12">
        <ProductGrid products={products} />
      </div>
    </div>
  );
}

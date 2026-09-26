import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import {
  getProductBySlug,
  getProductImages,
  getRelatedProducts,
} from "@/lib/storefront";
import { flatProductHistoryPath, resolveOldPath } from "@/lib/redirects";
import { getProductSizes } from "@/lib/sizes";
import { productHref } from "@/lib/urls";
import { productMetaDescription } from "@/lib/metadata";
import ProductDetail from "@/components/product/ProductDetail";
import { openGraph, productImageUrl } from "@/lib/seo";

/**
 * The old flat product URL.
 *
 * Kept forever as a 301 to the hierarchical path. These URLs are in customers'
 * histories, in WhatsApp messages and in Google's index; dropping them would
 * throw away every link the shop has earned so far.
 *
 * It still RENDERS for the one case with nowhere to redirect to: a product
 * whose category has no published parent has no hierarchical path, and 404ing
 * it would take a live product off the site over a filing detail.
 */
export const revalidate = 60;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const product = await getProductBySlug(params.slug);
  if (!product) return { title: "Product not found | THE WOVENNE" };

  /*
   * THE FALLBACK IS COMPOSED, NOT CANNED. This read
   * `product.description?.slice(0, 155) ?? "Authentic handloom linen from
   * Kerala."`, which did two wrong things at once: it cut real descriptions
   * mid-word and left their paragraph breaks in the tag, and it told a third of
   * the catalogue — jewellery included — that it was linen from Kerala.
   *
   * productMetaDescription() truncates on a word boundary and, where nothing is
   * written, builds a sentence from values THIS page already shows: the name,
   * the fabric row, the sub-category. See lib/metadata for what it may not use.
   *
   * IT STOPS HERE. The Product node's own `description` stays
   * `product.description ?? undefined` — a meta description summarises a page,
   * a schema description states a fact about a piece, and the two must not
   * share a fallback. See lib/structuredData.
   */
  const description = productMetaDescription({
    name: product.name,
    description: product.description,
    categoryName: product.category,
    fabric: product.fabric,
  });

  return {
    title: `${product.name} | THE WOVENNE`,
    description,
    alternates: { canonical: productHref(product) },
    // "website", not "product": Next 14.2.5's OpenGraph union has no product
    // type and its generator throws on one. The Product facts a search engine
    // reads come from the JSON-LD node this page already emits. See lib/seo.
    openGraph: openGraph({
      title: product.name,
      description,
      path: productHref(product),
      images: [product.image_url ? productImageUrl(product.image_url, "openGraph") : null],
    }),
  };
}

export default async function LegacyProductPage({
  params,
}: {
  params: { slug: string };
}) {
  const product = await getProductBySlug(params.slug);

  if (!product) {
    // Renamed since this link was made — the history table still knows it.
    const moved = await resolveOldPath(flatProductHistoryPath(params.slug));
    if (moved) permanentRedirect(moved);
    notFound();
  }

  const canonical = productHref(product);
  if (canonical !== `/in/product/${params.slug}`) {
    permanentRedirect(canonical);
  }

  // No hierarchical path exists yet, so render in place rather than 404.
  const [related, gallery, sizes] = await Promise.all([
    getRelatedProducts(product.category_id, product.slug, 4),
    getProductImages(product.id),
    getProductSizes(product.id),
  ]);

  const images = (gallery.length ? gallery : [product.image_url]).filter(
    (src): src is string => Boolean(src)
  );

  return <ProductDetail
      product={product}
      images={images}
      related={related}
      sizes={sizes}
    />;
}

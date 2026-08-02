import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import {
  getProductBySlug,
  getProductImages,
  getRelatedProducts,
} from "@/lib/storefront";
import { resolveOldPath } from "@/lib/redirects";
import { getProductSizes } from "@/lib/sizes";
import { productHref } from "@/lib/urls";
import ProductDetail from "@/components/product/ProductDetail";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

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

  const description =
    product.description?.slice(0, 155) ??
    "Authentic handloom linen from Kerala.";

  return {
    title: `${product.name} | THE WOVENNE`,
    description,
    alternates: { canonical: productHref(product) },
    openGraph: {
      title: product.name,
      description,
      images: [product.image_url ?? DEFAULT_OG_IMAGE],
    },
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
    const moved = await resolveOldPath(`/product/${params.slug}`);
    if (moved) permanentRedirect(moved);
    notFound();
  }

  const canonical = productHref(product);
  if (canonical !== `/product/${params.slug}`) {
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

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getProductBySlug,
  getProductImages,
  getRelatedProducts,
} from "@/lib/products";
import { formatINR } from "@/lib/utils";
import { effectivePrice, savingAmount } from "@/lib/pricing";
import ImageGallery from "@/components/product/ImageGallery";
import ProductOptions from "@/components/product/ProductOptions";
import CareAccordion from "@/components/product/CareAccordion";
import ProductGrid from "@/components/shop/ProductGrid";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

export const revalidate = 60;

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
    openGraph: {
      title: product.name,
      description,
      images: [product.image_url ?? DEFAULT_OG_IMAGE],
    },
  };
}

export default async function ProductPage({
  params,
}: {
  params: { slug: string };
}) {
  const product = await getProductBySlug(params.slug);

  if (!product) {
    notFound();
  }

  const [related, gallery] = await Promise.all([
    getRelatedProducts(product.category_id, product.slug, 4),
    getProductImages(product.id),
  ]);

  // Fall back to the cover image if the gallery is empty, so a product with one
  // photo still renders while its extra shots are being added.
  const images = (gallery.length ? gallery : [product.image_url]).filter(
    (src): src is string => Boolean(src)
  );

  return (
    <div className="container-wovenne section-padding pb-28 lg:pb-24">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <ImageGallery images={images} alt={product.name} />

        <div>
          {product.category && (
            <p className="text-xs uppercase tracking-wider text-ink/50">
              {product.category}
            </p>
          )}
          <h1 className="mt-2 font-heading text-4xl text-ink sm:text-5xl">
            {product.name}
          </h1>
          <p className="mt-3 font-body text-2xl text-ink">
            {formatINR(effectivePrice(product).price)}
            {effectivePrice(product).wasPrice != null && (
              <span className="ml-3 align-middle text-base font-normal text-ink/40 line-through">
                {formatINR(effectivePrice(product).wasPrice!)}
              </span>
            )}
          </p>

          {product.description && (
            <p className="mt-6 text-base leading-relaxed text-ink/70">
              {product.description}
            </p>
          )}

          <div className="mt-8">
            <ProductOptions product={product} />
          </div>

          <CareAccordion fabric={product.fabric} />
        </div>
      </div>

      {related.length > 0 && (
        <div className="mt-24">
          <div className="text-center">
            <span className="font-script text-2xl text-terracotta">
              More From the Loom
            </span>
            <h2 className="mt-2 font-heading text-3xl text-ink sm:text-4xl">
              You May Also Like
            </h2>
          </div>
          <div className="mt-10">
            <ProductGrid products={related} />
          </div>
        </div>
      )}
    </div>
  );
}

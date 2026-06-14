import { notFound } from "next/navigation";
import { getProductBySlug, getRelatedProducts } from "@/lib/products";
import { formatGBP } from "@/lib/utils";
import ImageGallery from "@/components/product/ImageGallery";
import ProductOptions from "@/components/product/ProductOptions";
import CareAccordion from "@/components/product/CareAccordion";
import ProductGrid from "@/components/shop/ProductGrid";

export default async function ProductPage({
  params,
}: {
  params: { slug: string };
}) {
  const product = await getProductBySlug(params.slug);

  if (!product) {
    notFound();
  }

  const related = await getRelatedProducts(product.category, product.slug, 4);

  const images = [
    product.image_url,
    `https://placehold.co/800x1000/1C1F3B/FAF7F2?text=${encodeURIComponent(product.name)}`,
    `https://placehold.co/800x1000/C2714F/FAF7F2?text=Detail`,
  ].filter((src): src is string => Boolean(src));

  return (
    <div className="container-wovenne section-padding">
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
            {formatGBP(product.price_gbp)}
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

import Link from "next/link";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import ImageGallery from "@/components/product/ImageGallery";
import ProductOptions from "@/components/product/ProductOptions";
import CareAccordion from "@/components/product/CareAccordion";
import ProductVideo from "@/components/product/ProductVideo";
import ProductGrid from "@/components/shop/ProductGrid";
import WishlistButton from "@/components/shop/WishlistButton";
import ProductReviews from "@/components/product/ProductReviews";
import Stars from "@/components/product/Stars";
import { getReviews, getRating } from "@/lib/reviews";
import { cPath } from "@/lib/country";
import type { Product } from "@/lib/types";
import type { ProductSize } from "@/lib/sizes";

/**
 * The product page body, shared so the canonical hierarchical route is the only
 * place this markup lives.
 *
 * Reviews are fetched HERE rather than in each route, so the two routes that
 * render this cannot drift into showing different things. Both are public
 * reads, so they cache with the page.
 */
export default async function ProductDetail({
  product,
  images,
  related,
  sizes,
  breadcrumb,
}: {
  product: Product;
  images: string[];
  related: Product[];
  /** Empty for single-stock products such as sarees. */
  sizes: ProductSize[];
  /** Parent and sub-category, when the product is filed under both. */
  breadcrumb?: { parent: { slug: string; name: string }; child: { slug: string; name: string } };
}) {
  const { price, wasPrice } = effectivePrice(product);
  const [reviews, rating] = await Promise.all([
    getReviews(product.id),
    getRating(product.id),
  ]);

  return (
    <div className="container-wovenne section-padding pb-28 lg:pb-24">
      {breadcrumb && (
        <nav aria-label="Breadcrumb" className="mb-8 text-xs text-ink/50">
          <Link href={cPath(`/${breadcrumb.parent.slug}`)} className="hover:text-terracotta">
            {breadcrumb.parent.name}
          </Link>
          <span className="mx-2">/</span>
          <Link
            href={cPath(`/${breadcrumb.parent.slug}/${breadcrumb.child.slug}`)}
            className="hover:text-terracotta"
          >
            {breadcrumb.child.name}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-ink/70">{product.name}</span>
        </nav>
      )}

      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <ImageGallery images={images} alt={product.name} />

        <div>
          {product.category && (
            <p className="text-xs uppercase tracking-wider text-ink/50">
              {product.category}
            </p>
          )}
          <div className="mt-2 flex items-start justify-between gap-4">
            <h1 className="font-heading text-4xl text-ink sm:text-5xl">
              {product.name}
            </h1>
            <WishlistButton
              productId={product.id}
              productName={product.name}
              className="mt-1 shrink-0 border border-ink/10"
            />
          </div>
          {/* Only once there is something to say. A row of empty stars reading
              "no reviews" on every product makes a young catalogue look
              unloved, and says nothing a buyer can use. */}
          {rating.total > 0 && rating.average !== null && (
            <a
              href="#reviews"
              className="mt-3 inline-flex items-center gap-2 text-sm text-ink/60 transition-colors hover:text-ink"
            >
              <Stars rating={rating.average} />
              {rating.average.toFixed(1)} · {rating.total}{" "}
              {rating.total === 1 ? "review" : "reviews"}
            </a>
          )}

          <p className="mt-3 font-body text-2xl text-ink">
            {formatINR(price)}
            {wasPrice != null && (
              <span className="ml-3 align-middle text-base font-normal text-ink/40 line-through">
                {formatINR(wasPrice)}
              </span>
            )}
          </p>

          {product.description && (
            <p className="mt-6 text-base leading-relaxed text-ink/70">
              {product.description}
            </p>
          )}

          <div className="mt-8">
            <ProductOptions product={product} sizes={sizes} />
          </div>

          <CareAccordion fabric={product.fabric} />
        </div>
      </div>

      {/* Below the buy controls and above related pieces: someone who wants
          the video will scroll for it, and someone who does not is not made to
          scroll past it to reach the price. Nothing loads until they click. */}
      {product.video_youtube_id && (
        <ProductVideo videoId={product.video_youtube_id} productName={product.name} />
      )}

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

      <ProductReviews
        productId={product.id}
        reviews={reviews}
        rating={rating}
      />
    </div>
  );
}

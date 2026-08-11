import Link from "next/link";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import ImageGallery from "@/components/product/ImageGallery";
import ProductOptions from "@/components/product/ProductOptions";
import MaterialCare from "@/components/product/MaterialCare";
import BrandKnowledgePanel from "@/components/product/BrandKnowledgePanel";
import ProductStyleSection from "@/components/style/ProductStyleSection";
import ProductVideo from "@/components/product/ProductVideo";
import ProductGrid from "@/components/shop/ProductGrid";
import WishlistButton from "@/components/shop/WishlistButton";
import ProductReviews from "@/components/product/ProductReviews";
import DeliveryNote from "@/components/product/DeliveryNote";
import Stars from "@/components/product/Stars";
import { getReviews, getRating } from "@/lib/reviews";
import { getBrandKnowledge } from "@/lib/storefront";
import { getShippingConfig } from "@/lib/shipping";
import { cPath } from "@/lib/country";
import type { Product } from "@/lib/types";
import type { ProductSize } from "@/lib/sizes";
import { stockNote, stockState } from "@/lib/stock";

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
  // Decided before anything renders, so the note appears NEXT TO THE PRICE
  // rather than after a size is chosen — which was after the moment it mattered.
  // ONE-SIZE PRODUCTS ONLY. A sized piece says it beside the size instead, where
  // it follows what the customer actually picked — see ProductOptions. Keeping
  // both would put "almost gone in some sizes" under the price while the chosen
  // size says nothing, which is two answers to one question.
  const note = sizes.length === 0 ? stockNote(stockState(product.stock_quantity)) : null;
  // Fetched HERE for the same reason reviews are: both routes render this file,
  // and a read done in one route and not the other is how two pages start
  // showing different things about one product.
  //
  // A query of its own rather than a column on the listing payload — see
  // getBrandKnowledge. One extra read on the one page that shows it, instead of
  // three paragraphs per product on every category page.
  const [reviews, rating, knowledge, shipping] = await Promise.all([
    getReviews(product.id),
    getRating(product.id),
    getBrandKnowledge({ productId: product.id }),
    // The same config quoteShipping() charges from, so what the page promises
    // and what the till takes cannot drift apart.
    getShippingConfig(),
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

        {/* STICKY ON DESKTOP, and it needs BOTH of these elements to work. A
            gallery is tall and a buy panel is short: without this, a piece with
            no description leaves half a column of empty cream and the price
            scrolls away while somebody is still looking at the cloth.
            
            The outer div is the grid item and must STRETCH to the row height —
            that is the travel sticky moves within. The inner div is what sticks.
            Collapsing these into one (or adding items-start) gives the item the
            height of its own content, leaving zero slack, and sticky silently
            does nothing. It looks applied in the inspector and behaves as if it
            is not. */}
        <div>
          <div className="lg:sticky lg:top-28">
          {product.category && (
            <p className="text-xs uppercase tracking-wider text-ink/50">
              {product.category}
            </p>
          )}
          <div className="mt-2 flex items-start justify-between gap-4">
            {/* The largest thing on the page, and the only h1. Tighter leading
                and a hair of negative tracking is what stops a long name in a
                serif reading as two separate lines of display type. */}
            <h1 className="font-heading text-4xl leading-[1.08] tracking-[-0.01em] text-ink sm:text-5xl">
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

          {/* Price sits BELOW the name and above the description, at a size that
              reads as information rather than as a shout. A luxury page states
              the number once and moves on. */}
          <p className="mt-4 font-body text-xl tracking-wide text-ink">
            {formatINR(price)}
            {wasPrice != null && (
              <span className="ml-3 align-middle text-base font-normal text-ink/40 line-through">
                {formatINR(wasPrice)}
              </span>
            )}
          </p>

          {note && (
            /* A gold dot and a line of small caps. No red, no badge, no count
               ticking down: the fact, said once, in the same voice as the rest
               of the page. Sold out reads the same way — a piece being gone is
               information, not a failure to apologise for. */
            <p className="mt-4 flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-ink/55">
              <span aria-hidden className="h-1 w-1 rounded-full bg-gold" />
              {note}
            </p>
          )}

          {product.description && (
            <p className="mt-6 max-w-prose text-[15px] leading-[1.75] text-ink/70">
              {product.description}
            </p>
          )}

          {/* A rule rather than a gap between reading about the piece and
              choosing one. It marks where the page stops describing and starts
              asking. */}
          <div className="mt-8 border-t border-ink/10 pt-8">
            <ProductOptions product={product} sizes={sizes} />
          </div>

          {/* Immediately under the purchase controls, which is where the
              question "will postage be added?" actually gets asked. */}
          <div className="mt-8">
            <DeliveryNote shipping={shipping} />
          </div>

          {product.fabric && (
            // The fabric named where it helps a decision; how to wash it now has
            // its own section further down. One line here, not an accordion.
            <p className="mt-6 text-xs uppercase tracking-wider text-ink/45">
              {product.fabric}
            </p>
          )}
          </div>
        </div>
      </div>

      {/* ── Below the fold, in the confirmed order ──────────────────
          video → story → care → reviews → styled by customers → related.

          Related pieces come LAST, deliberately. They used to sit above the
          reviews, which meant the page offered somebody a different product
          before it had finished telling them about this one. Everything that
          argues for THIS piece now runs first, and the invitation to look
          elsewhere is the last thing on the page. */}

      {/* Nothing loads until it is pressed — see ProductVideo. */}
      {product.video_youtube_id && (
        <ProductVideo videoId={product.video_youtube_id} productName={product.name} />
      )}

      <BrandKnowledgePanel knowledge={knowledge} productName={product.name} />

      {/* The written note wins over the fabric table — a piece somebody has
          written care instructions for should not be described by a lookup. */}
      <MaterialCare fabric={product.fabric} careNote={knowledge?.care ?? null} />

      <ProductReviews productId={product.id} reviews={reviews} rating={rating} />

      <ProductStyleSection productId={product.id} productName={product.name} />

      {related.length > 0 && (
        <div className="mt-24 border-t border-ink/10 pt-16">
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

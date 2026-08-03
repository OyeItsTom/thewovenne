import Link from "next/link";
import ProductCard from "@/components/shop/ProductCard";
import type { CuratedSet } from "@/lib/curated";

/**
 * The curated set: a chosen handful, not the catalogue.
 *
 * The heading tells the truth about which one you are looking at. "Picked for
 * you" over a row that is really just new arrivals is the kind of small lie
 * that teaches people to distrust everything else on the page — and someone
 * with a wishlist can tell instantly.
 */
export default function CuratedForYou({ set }: { set: CuratedSet }) {
  if (set.products.length === 0) return null;

  const personal = set.reason === "personal";

  return (
    <section className="section-padding container-wovenne">
      <div className="text-center">
        <span className="font-script text-2xl text-terracotta">
          {personal ? "For you" : "New in"}
        </span>
        <h2 className="mt-2 font-heading text-4xl text-ink sm:text-5xl">
          {personal ? "Chosen from what you've saved" : "From the Latest Weave"}
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm text-ink/55">
          {personal
            ? `Pieces that share the colours and cloth of the ${set.basedOn} ${
                set.basedOn === 1 ? "piece" : "pieces"
              } on your wishlist.`
            : "The most recent additions to the collection."}
        </p>
      </div>

      <div className="mt-14 grid grid-cols-2 gap-6 md:grid-cols-4 md:gap-8">
        {set.products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>

      <div className="mt-12 text-center">
        <Link
          href="/shop"
          className="inline-block border-b border-terracotta pb-1 text-xs uppercase tracking-widest text-terracotta"
        >
          See everything
        </Link>
      </div>
    </section>
  );
}

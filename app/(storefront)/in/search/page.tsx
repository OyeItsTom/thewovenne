import type { Metadata } from "next";
import Link from "next/link";
import { searchProducts } from "@/lib/search";
import ProductGrid from "@/components/shop/ProductGrid";
import SearchField from "@/components/shop/SearchField";

export const metadata: Metadata = {
  title: "Search | THE WOVENNE",
  // Search result pages are thin, endless and duplicate the shop — exactly
  // what a crawler should not spend its budget on.
  robots: { index: false, follow: true },
};

// Results follow the published catalogue, which changes when Publish is pressed.
export const revalidate = 60;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const query = (searchParams.q ?? "").slice(0, 120);
  const { products, terms } = await searchProducts(query);
  const searched = terms.length > 0;

  return (
    <div className="container-wovenne section-padding">
      <div className="mx-auto max-w-xl text-center">
        <p className="eyebrow">Search</p>
        <h1 className="mt-3 font-heading text-display-sm text-ink">
          {searched ? "Results" : "What are you looking for?"}
        </h1>

        <div className="mt-8">
          {/* Repeated here, not only in the nav: arriving from a link or a
              bookmark should still let you change the query without hunting
              for the icon. */}
          <SearchField initialQuery={query} autoFocus={!searched} />
        </div>
      </div>

      <div className="mt-14">
        {!searched ? (
          <p className="text-center text-sm text-ink/60">
            Try a fabric, a colour, or a kind of piece — linen, indigo, saree.
          </p>
        ) : products.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-ink/70">
              Nothing matches{" "}
              <span className="text-ink">&ldquo;{query.trim()}&rdquo;</span>.
            </p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink/55">
              Every word has to appear somewhere, so fewer words often find
              more.
            </p>
            <Link
              href="/in/shop"
              className="mt-6 inline-block border-b border-terracotta pb-1 text-xs uppercase tracking-widest text-terracotta"
            >
              Browse everything
            </Link>
          </div>
        ) : (
          <>
            <p className="mb-8 text-center text-xs uppercase tracking-widest text-ink/45">
              {products.length} {products.length === 1 ? "piece" : "pieces"}
            </p>
            <ProductGrid products={products} />
          </>
        )}
      </div>
    </div>
  );
}

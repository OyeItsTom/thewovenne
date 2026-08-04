import type { Metadata } from "next";
import Link from "next/link";
import { createRSCClient } from "@/lib/supabaseRSC";
import { getProductsByIds } from "@/lib/products";
import ProductGrid from "@/components/shop/ProductGrid";
import { buttonClassName } from "@/components/ui/Button";

export const metadata: Metadata = {
  title: "Your wishlist | THE WOVENNE",
  robots: { index: false, follow: false },
};

// Personal, and never the same twice — nothing here should be cached.
export const dynamic = "force-dynamic";

export default async function WishlistPage() {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The middleware already turns guests away, so this is the belt to its
  // braces: a page holding one person's saved items should not depend on a
  // single check.
  if (!user) {
    return (
      <div className="container-wovenne section-padding text-center">
        <h1 className="font-heading text-display-sm text-ink">Your wishlist</h1>
        <p className="mx-auto mt-4 max-w-sm text-sm text-ink/60">
          Log in to see the pieces you&apos;ve saved.
        </p>
        <Link
          href="/in/login?from=/in/account/wishlist"
          className={buttonClassName("primary", "lg", "mt-8")}
        >
          Log in
        </Link>
      </div>
    );
  }

  // RLS restricts this to the signed-in user's rows; no user_id filter is
  // needed here, and adding one would imply the policy were optional.
  const { data: rows } = await supabase
    .from("wishlists")
    .select("product_id")
    .order("created_at", { ascending: false });

  const ids = (rows ?? []).map((r) => r.product_id as string);
  const products = ids.length ? await getProductsByIds(ids) : [];

  // The account layout owns the sidebar and the page padding. This page kept
  // its own copies from before that layout existed, which is why choosing
  // Wishlist drew the whole menu again inside the content.
  return (
    <div>
      <h1 className="font-heading text-display-sm text-ink">Your wishlist</h1>

      <div className="mt-8">
        {products.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-ink/60">
              Nothing saved yet. Tap the heart on anything you like.
            </p>
            <Link
              href="/in/shop"
              className="mt-6 inline-block border-b border-terracotta pb-1 text-xs uppercase tracking-widest text-terracotta"
            >
              Browse the collection
            </Link>
          </div>
        ) : (
          <ProductGrid products={products} />
        )}
      </div>
    </div>
  );
}

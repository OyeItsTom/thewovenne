import type { Metadata } from "next";
import Link from "next/link";
import { createRSCClient } from "@/lib/supabaseRSC";
import { getProductsByIds } from "@/lib/products";
import ProfileForm from "@/components/account/ProfileForm";
import ProductGrid from "@/components/shop/ProductGrid";

export const metadata: Metadata = {
  title: "Your profile | THE WOVENNE",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Who the customer is, and what they have their eye on.
 *
 * The wishlist is shown HERE rather than only linked, because it is the one
 * thing on the account worth looking at rather than acting on — the reason to
 * come back. Everything that changes a setting now lives under Settings, which
 * leaves this page as a single coherent thing instead of details stacked on
 * top of levers.
 *
 * The full wishlist keeps its own page: this is a preview, capped, with a way
 * through to the rest.
 */
const PREVIEW_COUNT = 8;

export default async function ProfilePage() {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = user
    ? await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null };

  const profile = (data as { full_name?: string; email?: string } | null) ?? null;

  // Phone is not on the profile: it is captured per order at checkout, because
  // a delivery number can differ from order to order. The most recent one is
  // shown so the page is not silent about something we clearly hold.
  const { data: lastOrder } = user
    ? await supabase
        .from("orders")
        .select("customer_phone")
        .not("customer_phone", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  // RLS restricts this to the signed-in customer's rows.
  const { data: savedRows } = user
    ? await supabase
        .from("wishlists")
        .select("product_id")
        .order("created_at", { ascending: false })
    : { data: null };

  const savedIds = (savedRows ?? []).map((r) => r.product_id as string);
  const saved = savedIds.length
    ? await getProductsByIds(savedIds.slice(0, PREVIEW_COUNT))
    : [];

  return (
    <div className="space-y-12">
      <div className="space-y-8">
        <div>
          <h1 className="font-heading text-display-sm text-ink">Profile</h1>
          <p className="mt-2 text-sm text-ink/60">Your details.</p>
        </div>

        <ProfileForm
          initialName={profile?.full_name ?? ""}
          email={profile?.email ?? user?.email ?? ""}
          lastPhone={
            (lastOrder as { customer_phone?: string } | null)?.customer_phone ?? null
          }
        />
      </div>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-heading text-2xl text-ink">Your wishlist</h2>
          {savedIds.length > PREVIEW_COUNT && (
            <Link
              href="/in/account/wishlist"
              className="border-b border-terracotta pb-0.5 text-xs uppercase tracking-widest text-terracotta"
            >
              All {savedIds.length} saved
            </Link>
          )}
        </div>

        <div className="mt-6">
          {saved.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ink/15 px-6 py-12 text-center">
              <p className="text-sm text-ink/60">
                Nothing saved yet. Tap the heart on anything you like.
              </p>
              <Link
                href="/in/shop"
                className="mt-5 inline-block border-b border-terracotta pb-1 text-xs uppercase tracking-widest text-terracotta"
              >
                Browse the collection
              </Link>
            </div>
          ) : (
            <ProductGrid products={saved} />
          )}
        </div>
      </section>
    </div>
  );
}

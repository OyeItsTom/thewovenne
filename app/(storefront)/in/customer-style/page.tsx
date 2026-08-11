import type { Metadata } from "next";
import Link from "next/link";
import { getApprovedStyle } from "@/lib/style";
import StyleGallery from "@/components/style/StyleGallery";
import { buttonClassName } from "@/components/ui/Button";
import { cPath } from "@/lib/country";

/**
 * WORN BY YOU is the customer-facing name; "Customer Style" survives as the
 * route, the table and the admin queue, where precision beats warmth. The URL
 * does not change with the label — it is indexed, and a rename would cost the
 * page its history to save four characters nobody reads.
 */
export const metadata: Metadata = {
  title: "Worn by You | THE WOVENNE",
  description:
    "Photographs sent to us by the people who wear our cloth — handloom linen and natural fibres, woven in Kerala.",
};

/**
 * Photographs our customers have sent us.
 *
 * CACHED LIKE EVERY OTHER STOREFRONT PAGE. The content changes when an admin
 * approves something, which is minutes-scale, not seconds-scale — so this is a
 * static page revalidated on a timer rather than a dynamic render per visitor.
 * The homepage's 993ms TTFB (#74) came from exactly the opposite decision.
 *
 * OPEN TO EVERYONE, no login. It reads public_style_submissions, which is
 * granted to anon and is the single definition of what may be shown: approved,
 * consented, not withdrawn.
 */
export const revalidate = 60;

export default async function CustomerStylePage() {
  const items = await getApprovedStyle();

  return (
    <div className="container-wovenne section-padding">
      <header className="mx-auto max-w-2xl text-center">
        <span className="font-script text-2xl text-terracotta">Worn for life</span>
        <h1 className="mt-3 font-heading text-display-sm text-ink">Worn by You</h1>
        <p className="mt-5 text-base leading-relaxed text-ink/65">
          Photographs sent to us by the people who wear the cloth. Every one is
          here because its owner asked for it to be — and can ask for it to come
          down whenever they like.
        </p>
      </header>

      <div className="mt-16">
        {items.length > 0 ? (
          <StyleGallery items={items} />
        ) : (
          /* The state this page ships in, so it is designed rather than
             discovered. An empty grid with a heading over it reads as broken;
             this reads as early. */
          <div className="mx-auto max-w-md rounded-2xl border border-ink/10 bg-linen/40 px-6 py-16 text-center">
            <p className="font-heading text-2xl text-ink">
              The first photograph hasn&apos;t arrived yet
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink/60">
              When someone shares how they wear a piece, it appears here. If
              you&apos;ve bought from us, yours could be the one.
            </p>
          </div>
        )}
      </div>

      <div className="mt-20 border-t border-ink/10 pt-12 text-center">
        <h2 className="font-heading text-2xl text-ink">Share your style</h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink/60">
          {/* Says the condition rather than letting somebody find out by being
              refused: the submission form only exists on a delivered order. */}
          Anyone who has received an order can send us a photograph from their
          orders page. We look at every one ourselves.
        </p>
        <Link href={cPath("/account/orders")} className={buttonClassName("primary", "lg", "mt-8")}>
          Go to your orders
        </Link>
      </div>
    </div>
  );
}

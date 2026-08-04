import Hero from "@/components/home/Hero";
import WhyLinen from "@/components/home/WhyLinen";
import InstagramGrid from "@/components/home/InstagramGrid";
import WovenSeam from "@/components/weave/WovenSeam";
import CuratedPersonalizer from "@/components/home/CuratedPersonalizer";
import SeasonalEdit from "@/components/home/SeasonalEdit";
import LookbookSections from "@/components/home/LookbookSections";
import { getCuratedProducts } from "@/lib/curated";
import { getContent } from "@/lib/storefront";


/**
 * Hero → Seasonal → Lookbook → Curated → Instagram → Why us.
 *
 * OUR STORY IS NOT HERE ANY MORE. It still exists at /about — the copy is
 * intact and admin-editable — but a brand essay sitting between the products
 * and the proof was asking browsers to read before they had seen anything
 * worth reading about.
 *
 * CACHED, and personalised afterwards. This page was force-dynamic so the
 * curated set could vary per customer, which cost 993 ms to first byte against
 * 64-130 ms on every other page — paid by every first-time visitor, who has no
 * wishlist to personalise from in the first place.
 *
 * Now it renders the same cached new arrivals for everyone, and a signed-in
 * customer's browser swaps in their own set after paint. See
 * CuratedPersonalizer.
 */
export const revalidate = 60;

export default async function Home() {
  // `null` and `false`: build the guest set. No session is read here, because
  // reading one is exactly what made the page uncacheable.
  const [curated, hero, whyLinen, seasonal, lookbook] = await Promise.all([
    getCuratedProducts(null, false),
    getContent("home_hero"),
    getContent("why_linen"),
    getContent("seasonal_edit"),
    getContent("lookbook"),
  ]);

  return (
    <>
      <Hero content={hero} />

      {/* Renders nothing when no campaign is enabled. */}
      <SeasonalEdit content={seasonal} />

      {/* Renders nothing until a section is enabled and has an image. */}
      <LookbookSections content={lookbook} />

      <CuratedPersonalizer initial={curated} />
      <WovenSeam />

      <InstagramGrid />
      <WovenSeam />

      <WhyLinen content={whyLinen} />
    </>
  );
}

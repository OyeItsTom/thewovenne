import Hero from "@/components/home/Hero";
import WhyLinen from "@/components/home/WhyLinen";
import InstagramGrid from "@/components/home/InstagramGrid";
import WovenSeam from "@/components/weave/WovenSeam";
import CuratedPersonalizer from "@/components/home/CuratedPersonalizer";
import SeasonalEdit from "@/components/home/SeasonalEdit";
import LookbookSections from "@/components/home/LookbookSections";
import { getCuratedProducts } from "@/lib/curated";
import { getContent } from "@/lib/storefront";
import JsonLd from "@/components/seo/JsonLd";
import { organizationNode } from "@/lib/structuredData";
import { cPath } from "@/lib/country";
import type { Metadata } from "next";


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

/**
 * ONLY A CANONICAL. Title, description and the Open Graph block still come from
 * the root layout — Next merges metadata field by field down the chain, and
 * nothing here names them, so nothing here replaces them. Declaring an
 * openGraph key would swap the layout's out wholesale (see lib/seo), which is
 * exactly the trap this stays clear of.
 *
 * WHY THE HOME PAGE NEEDS ONE AT ALL. It had none, and self-canonicalising was
 * nearly harmless: "/" permanently redirects here, so there was no second
 * address serving this page. Query strings are the gap. Every link out of an
 * Instagram post or a marketing email arrives as /in?utm_source=..., each one a
 * distinct URL returning 200 with identical content and, until now, pointing at
 * itself. This consolidates them onto the plain path — the same reason
 * /in/shop names its unfiltered self rather than each filter combination.
 *
 * Through cPath, so it says /in rather than a bare "/" that would only 308.
 */
export const metadata: Metadata = {
  alternates: { canonical: cPath("/") },
};

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
      {/* HERE AND NOWHERE ELSE. Google asks for organization markup on the home
          page or one page describing the business, not on every page — and this
          is the home page: "/" only 308s to it. Repeating it on each PDP would
          add weight to every crawl and say nothing it does not say once here. */}
      <JsonLd data={organizationNode()} />

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

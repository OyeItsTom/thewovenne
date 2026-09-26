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
import { openGraph } from "@/lib/seo";
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

const TITLE = "Handloom Cotton Sarees, Clothing & Jewellery | THE WOVENNE";
// No "Woven in India": this sentence names jewellery too, and a trailing origin
// claim would attach to the whole list. See the note in app/layout.tsx.
const DESCRIPTION =
  "Shop handloom cotton sarees, clothing and jewellery from THE WOVENNE. Priced in ₹, shipped across India.";

/**
 * THE HOME PAGE SPEAKS FOR ITSELF NOW.
 *
 * It used to carry only a canonical, and inherit its title and description from
 * the root layout. That was a deliberate choice and it stopped being the right
 * one when the inherited description turned out to describe a different shop:
 * "Authentic handloom Indian linen ... for the UK", on a storefront that sells
 * cotton into India. The single most-linked page on the site was advertising
 * two facts that were not true, and no amount of correctness elsewhere reaches
 * a page that has no words of its own.
 *
 * ITS OWN openGraph BLOCK IS SAFE — now. Declaring one used to mean silently
 * discarding the layout's type, siteName and image, which is why this file
 * avoided the key entirely. openGraph() carries all four, so the trap is closed
 * at the helper rather than by every route remembering it. See lib/seo.
 *
 * WHY THE CANONICAL EXISTS AT ALL, unchanged: "/" permanently redirects here,
 * so there was no second address serving this page — but every link out of an
 * Instagram post or a marketing email arrives as /in?utm_source=..., each one a
 * distinct URL returning 200 with identical content and, until this, pointing
 * at itself. This consolidates them onto the plain path, the same reason
 * /in/shop names its unfiltered self rather than each filter combination.
 *
 * Through cPath, so it says /in rather than a bare "/" that would only 308.
 */
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: cPath("/") },
  openGraph: openGraph({ title: TITLE, description: DESCRIPTION, path: cPath("/") }),
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

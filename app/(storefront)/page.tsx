import Hero from "@/components/home/Hero";
import WhyLinen from "@/components/home/WhyLinen";
import CuratedForYou from "@/components/home/CuratedForYou";
import SeasonalEdit from "@/components/home/SeasonalEdit";
import InstagramGrid from "@/components/home/InstagramGrid";
import WovenSeam from "@/components/weave/WovenSeam";
import { createRSCClient } from "@/lib/supabaseRSC";
import { getCuratedProducts } from "@/lib/curated";
import { getContent } from "@/lib/storefront";

/**
 * Hero → Seasonal → Curated → Instagram → Why us.
 *
 * OUR STORY IS NOT HERE ANY MORE. It still exists at /about — the copy is
 * intact and admin-editable — but a brand essay sitting between the products
 * and the proof was asking browsers to read before they had seen anything
 * worth reading about.
 *
 * The page is dynamic rather than revalidated now: the curated set depends on
 * who is looking, and a cached homepage would serve one customer's wishlist
 * matches to everybody. The editable content it also renders is fetched the
 * same way as before; only the caching changed.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [curated, hero, whyLinen, seasonal] = await Promise.all([
    getCuratedProducts(supabase, Boolean(user)),
    getContent("home_hero"),
    getContent("why_linen"),
    getContent("seasonal_edit"),
  ]);

  return (
    <>
      <Hero content={hero} />

      {/* Renders nothing when no campaign is enabled. */}
      <SeasonalEdit content={seasonal} />

      <CuratedForYou set={curated} />
      <WovenSeam />

      <InstagramGrid />
      <WovenSeam />

      <WhyLinen content={whyLinen} />
    </>
  );
}

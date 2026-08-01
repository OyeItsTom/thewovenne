import Hero from "@/components/home/Hero";
import WhyLinen from "@/components/home/WhyLinen";
import FeaturedProducts from "@/components/home/FeaturedProducts";
import SeasonalEdit from "@/components/home/SeasonalEdit";
import BrandStory from "@/components/home/BrandStory";
import InstagramGrid from "@/components/home/InstagramGrid";
import WovenSeam from "@/components/weave/WovenSeam";
import { getFeaturedProducts } from "@/lib/products";
import { getContent } from "@/lib/content";

// Editable homepage content is public + rarely changes; revalidate periodically.
export const revalidate = 60;

export default async function Home() {
  const [featuredProducts, hero, whyLinen, brandStory, seasonal] =
    await Promise.all([
      getFeaturedProducts(4),
      getContent("home_hero"),
      getContent("why_linen"),
      getContent("brand_story"),
      getContent("seasonal_edit"),
    ]);

  return (
    <>
      <Hero content={hero} />
      <SeasonalEdit content={seasonal} />
      <WovenSeam />
      <WhyLinen content={whyLinen} />
      <FeaturedProducts products={featuredProducts} />
      <WovenSeam />
      <BrandStory content={brandStory} />
      <InstagramGrid />
    </>
  );
}

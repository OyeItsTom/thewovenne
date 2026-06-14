import Hero from "@/components/home/Hero";
import WhyLinen from "@/components/home/WhyLinen";
import FeaturedProducts from "@/components/home/FeaturedProducts";
import BrandStory from "@/components/home/BrandStory";
import InstagramGrid from "@/components/home/InstagramGrid";
import { getFeaturedProducts } from "@/lib/products";

export default async function Home() {
  const featuredProducts = await getFeaturedProducts(4);

  return (
    <>
      <Hero />
      <WhyLinen />
      <FeaturedProducts products={featuredProducts} />
      <BrandStory />
      <InstagramGrid />
    </>
  );
}

import type { Metadata } from "next";
import { getAllProducts } from "@/lib/products";
import { getVisibleCategoryTree } from "@/lib/categories";
import ShopFilters from "@/components/shop/ShopFilters";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

// Cache the catalogue for 60s so the DB isn't queried on every request.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Shop All | THE WOVENNE",
  description:
    "Authentic handloom linen from Kerala — shirts, kurtas, sarees, and home. Woven in India, priced in ₹.",
  openGraph: {
    title: "Shop All | THE WOVENNE",
    description:
      "Authentic handloom linen from Kerala — shirts, kurtas, sarees, and home.",
    images: [DEFAULT_OG_IMAGE],
  },
};

export default async function ShopPage() {
  const [products, categoryTree] = await Promise.all([
    getAllProducts(),
    getVisibleCategoryTree(),
  ]);

  return (
    <div className="container-wovenne section-padding">
      <div className="text-center">
        <p className="eyebrow">The Collection</p>
        <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
          Shop All
        </h1>
      </div>
      <ShopFilters products={products} categoryTree={categoryTree} />
    </div>
  );
}

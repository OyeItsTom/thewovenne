import type { Product } from "@/lib/types";
import ProductCard from "@/components/shop/ProductCard";

export default function FeaturedProducts({ products }: { products: Product[] }) {
  if (products.length === 0) return null;

  return (
    <section className="section-padding container-wovenne">
      <div className="text-center">
        <span className="font-script text-2xl text-terracotta">Featured</span>
        <h2 className="mt-2 font-heading text-4xl text-ink sm:text-5xl">
          From the Latest Weave
        </h2>
      </div>

      <div className="mt-14 grid grid-cols-2 gap-6 md:grid-cols-4 md:gap-8">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}

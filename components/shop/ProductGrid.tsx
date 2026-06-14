import type { Product } from "@/lib/types";
import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import ProductCard from "./ProductCard";

export default function ProductGrid({
  products,
}: {
  products: Product[] | null;
}) {
  if (products === null) {
    return (
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 md:gap-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <p className="py-20 text-center text-sm text-ink/60">
        No products match these filters.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 md:gap-8">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}

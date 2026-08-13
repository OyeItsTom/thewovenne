import type { ProductListing } from "@/lib/types";
import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import ProductCard from "./ProductCard";

export default function ProductGrid({
  products,
}: {
  products: ProductListing[] | null;
}) {
  if (products === null) {
    return (
      <div className="-mx-5 grid grid-cols-2 gap-x-0 gap-y-6 sm:mx-0 sm:grid-cols-3 sm:gap-6 lg:grid-cols-4 lg:gap-8">
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
    <div className="-mx-5 grid grid-cols-2 gap-x-0 gap-y-6 sm:mx-0 sm:grid-cols-3 sm:gap-6 lg:grid-cols-4 lg:gap-8">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}

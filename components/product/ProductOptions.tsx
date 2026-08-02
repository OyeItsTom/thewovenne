"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";
import type { ProductSize } from "@/lib/sizes";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import SizeSelector from "./SizeSelector";
import AddToCart from "./AddToCart";
import { effectivePrice } from "@/lib/pricing";

/** What the cart records when a product has no sizes of its own. */
const NO_SIZE = "One Size";

export default function ProductOptions({
  product,
  sizes,
}: {
  product: Product;
  /** Empty for single-stock products such as sarees. */
  sizes: ProductSize[];
}) {
  // Start on the first size that can actually be bought, so the default
  // selection is never one the customer is not allowed to add.
  const firstAvailable = sizes.find((s) => s.stock_quantity > 0);
  const [size, setSize] = useState(firstAvailable?.label ?? NO_SIZE);
  const addItem = useCartStore((s) => s.addItem);
  const openCart = useCartStore((s) => s.openCart);

  // With sizes, availability is per size — a product with stock in L is not
  // buyable in a sold-out M.
  const selected = sizes.find((s) => s.label === size);
  const outOfStock =
    sizes.length > 0
      ? !selected || selected.stock_quantity <= 0
      : product.stock_quantity <= 0;

  const quickAdd = () => {
    addItem(
      {
        id: product.id,
        slug: product.slug,
        name: product.name,
        price_inr: effectivePrice(product).price,
        image_url: product.image_url,
        size,
      },
      1
    );
    openCart();
  };

  return (
    <div className="space-y-6">
      <SizeSelector sizes={sizes} selected={size} onSelect={setSize} />
      <AddToCart
        product={product}
        size={size}
        disabled={outOfStock}
        available={sizes.length > 0 ? (selected?.stock_quantity ?? 0) : undefined}
      />

      {/* Sticky add-to-cart bar — mobile only. Adds one of the selected size. */}
      {/* pr-24 clears the floating WhatsApp button at bottom-right. */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-ink/10 bg-cream/95 py-3 pl-4 pr-24 backdrop-blur lg:hidden">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{product.name}</p>
          <p className="text-sm text-ink/70">{formatINR(effectivePrice(product).price)}</p>
        </div>
        <button
          onClick={quickAdd}
          disabled={outOfStock}
          className="shrink-0 rounded-full bg-terracotta px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-terracotta-dark disabled:opacity-50"
        >
          {outOfStock ? "Out of Stock" : `Add · ${size}`}
        </button>
      </div>
    </div>
  );
}

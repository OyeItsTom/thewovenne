"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import SizeSelector from "./SizeSelector";
import AddToCart from "./AddToCart";

const CLOTHING_SIZES = ["S", "M", "L", "XL"];
const ONE_SIZE = ["One Size"];

export default function ProductOptions({ product }: { product: Product }) {
  const sizes = product.category === "Home" ? ONE_SIZE : CLOTHING_SIZES;
  const [size, setSize] = useState(sizes[0]);
  const addItem = useCartStore((s) => s.addItem);
  const openCart = useCartStore((s) => s.openCart);
  const outOfStock = product.stock_quantity <= 0;

  const quickAdd = () => {
    addItem(
      {
        id: product.id,
        slug: product.slug,
        name: product.name,
        price_inr: product.price_inr,
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
      <AddToCart product={product} size={size} />

      {/* Sticky add-to-cart bar — mobile only. Adds one of the selected size. */}
      {/* pr-24 clears the floating WhatsApp button at bottom-right. */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-ink/10 bg-cream/95 py-3 pl-4 pr-24 backdrop-blur lg:hidden">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{product.name}</p>
          <p className="text-sm text-ink/70">{formatINR(product.price_inr)}</p>
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

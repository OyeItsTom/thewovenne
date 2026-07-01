"use client";

import { useState } from "react";
import { MessageCircle, Minus, Plus } from "lucide-react";
import type { Product } from "@/lib/types";
import { useCartStore } from "@/lib/store";
import Button from "@/components/ui/Button";

export default function AddToCart({
  product,
  size,
}: {
  product: Product;
  size: string;
}) {
  const [quantity, setQuantity] = useState(1);
  const addItem = useCartStore((s) => s.addItem);
  const openCart = useCartStore((s) => s.openCart);

  const outOfStock = product.stock_quantity <= 0;
  const max = Math.max(product.stock_quantity, 0);

  const handleAdd = () => {
    addItem(
      {
        id: product.id,
        slug: product.slug,
        name: product.name,
        price_inr: product.price_inr,
        image_url: product.image_url,
        size,
      },
      quantity
    );
    openCart();
  };

  const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
  const waMessage = encodeURIComponent(
    `Hi, I'd like to know more about ${product.name}`
  );
  const waHref = `https://wa.me/${number}?text=${waMessage}`;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-heading text-sm uppercase tracking-wider text-ink/60">
          Quantity
        </h3>
        <div className="mt-3 flex w-fit items-center gap-4 rounded-full border border-ink/15 px-2">
          <button
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            disabled={outOfStock}
            aria-label="Decrease quantity"
            className="p-3 text-ink/60 transition-colors hover:text-ink disabled:opacity-40"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="w-6 text-center">{quantity}</span>
          <button
            onClick={() => setQuantity((q) => Math.min(max, q + 1))}
            disabled={outOfStock || quantity >= max}
            aria-label="Increase quantity"
            className="p-3 text-ink/60 transition-colors hover:text-ink disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          onClick={handleAdd}
          disabled={outOfStock}
          size="lg"
          className="flex-1"
        >
          {outOfStock ? "Out of Stock" : "Add to Cart"}
        </Button>
        <a
          href={waHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-ink/15 px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-[#25D366] hover:text-[#1da851] sm:text-base"
        >
          <MessageCircle className="h-5 w-5" /> Ask on WhatsApp
        </a>
      </div>
    </div>
  );
}

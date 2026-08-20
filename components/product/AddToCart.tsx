"use client";

import { useState } from "react";
import { MessageCircle, Minus, Plus } from "lucide-react";
import type { Product } from "@/lib/types";
import { useCartStore } from "@/lib/store";
import Button from "@/components/ui/Button";
import { effectivePrice } from "@/lib/pricing";
import { whatsappProductEnquiry } from "@/lib/whatsapp";

export default function AddToCart({
  product,
  size,
  /** Availability of the SELECTED size, decided by the parent. */
  disabled = false,
  /** Units left in the selected size; falls back to the product's own count. */
  available,
}: {
  product: Product;
  size: string;
  disabled?: boolean;
  available?: number;
}) {
  const [quantity, setQuantity] = useState(1);
  const addItem = useCartStore((s) => s.addItem);
  const openCart = useCartStore((s) => s.openCart);

  // Capped by what is actually left in this size, so the quantity stepper
  // cannot offer more than can be sold.
  const stock = available ?? product.stock_quantity;
  const outOfStock = disabled || stock <= 0;
  const max = Math.max(stock, 0);

  const handleAdd = () => {
    addItem(
      {
        id: product.id,
        slug: product.slug,
        name: product.name,
        price_inr: effectivePrice(product).price,
        image_url: product.image_url,
        size,
      },
      quantity
    );
    openCart();
  };

  // Name AND the absolute product link, composed in lib/whatsapp so the message
  // has one definition rather than one per page that offers to ask.
  const waHref = whatsappProductEnquiry(product);

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
            className="tap-44 relative p-3 text-ink/60 transition-colors hover:text-ink disabled:opacity-40"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="w-6 text-center">{quantity}</span>
          <button
            onClick={() => setQuantity((q) => Math.min(max, q + 1))}
            disabled={outOfStock || quantity >= max}
            aria-label="Increase quantity"
            className="tap-44 relative p-3 text-ink/60 transition-colors hover:text-ink disabled:opacity-40"
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
          {outOfStock ? "Sold out" : "Add to Cart"}
        </Button>
        {/* Without a number this drops out and Add to Cart takes the full row,
            which is the better purchase control anyway. */}
        {waHref && (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-ink/15 px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-[#25D366] hover:text-[#1da851] sm:text-base"
          >
            <MessageCircle className="h-5 w-5" /> Ask on WhatsApp
          </a>
        )}
      </div>
    </div>
  );
}

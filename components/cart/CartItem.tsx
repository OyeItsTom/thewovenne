"use client";

import Image from "next/image";
import { Minus, Plus, X } from "lucide-react";
import { type CartItem as CartItemType, useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";

export default function CartItem({ item }: { item: CartItemType }) {
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const removeItem = useCartStore((s) => s.removeItem);

  return (
    <div className="flex gap-4 py-4">
      <div className="relative h-24 w-20 flex-shrink-0 overflow-hidden rounded-lg bg-linen">
        {item.image_url && (
          <Image
            src={item.image_url}
            alt={item.name}
            fill
            sizes="80px"
            className="object-cover"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col justify-between">
        <div>
          <h3 className="font-heading text-base leading-tight text-ink">
            {item.name}
          </h3>
          <p className="mt-1 text-xs uppercase tracking-wider text-ink/50">
            Size {item.size}
          </p>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 rounded-full border border-ink/10 px-1">
            <button
              onClick={() =>
                updateQuantity(item.id, item.size, item.quantity - 1)
              }
              aria-label="Decrease quantity"
              className="p-1.5 text-ink/60 transition-colors hover:text-ink"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-4 text-center text-sm">{item.quantity}</span>
            <button
              onClick={() =>
                updateQuantity(item.id, item.size, item.quantity + 1)
              }
              aria-label="Increase quantity"
              className="p-1.5 text-ink/60 transition-colors hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <span className="font-body text-sm font-medium text-ink">
            {formatINR(item.price_inr * item.quantity)}
          </span>
        </div>
      </div>

      <button
        onClick={() => removeItem(item.id, item.size)}
        aria-label="Remove item"
        className="self-start text-ink/30 transition-colors hover:text-terracotta"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

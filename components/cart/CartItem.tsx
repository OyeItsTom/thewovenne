"use client";

import Image from "next/image";
import { Minus, Plus, X } from "lucide-react";
import { type CartItem as CartItemType, useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";

export default function CartItem({ item }: { item: CartItemType }) {
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const removeItem = useCartStore((s) => s.removeItem);

  return (
    // py-5 rather than py-4: the remove control sits at the top of each row and
    // its 44px target reaches 14px above the icon. At py-4 that reached into the
    // row above, close enough to its quantity controls to make a mis-tap plausible.
    // The extra 4px each side is what keeps the targets genuinely separate rather
    // than merely declared so.
    <div className="flex gap-4 py-5">
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

      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div>
          <h3 className="break-words font-heading text-base leading-tight text-ink">
            {item.name}
          </h3>
          <p className="mt-1 text-xs uppercase tracking-wider text-ink/50">
            Size {item.size}
          </p>
        </div>
        <div className="flex items-center justify-between">
          {/* gap-3 is the original spacing and it was already enough: 26px
              buttons 40px apart put the two 44px targets 66px centre to centre,
              which cannot overlap. Widening this to gap-4 squeezed the middle
              column at 320px and pushed the remove button outside the row. */}
          <div className="flex items-center gap-3 rounded-full border border-ink/10 px-1">
            <button
              onClick={() =>
                updateQuantity(item.id, item.size, item.quantity - 1)
              }
              aria-label="Decrease quantity"
              className="tap-44 relative p-1.5 text-ink/60 transition-colors hover:text-ink"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-4 text-center text-sm">{item.quantity}</span>
            <button
              onClick={() =>
                updateQuantity(item.id, item.size, item.quantity + 1)
              }
              aria-label="Increase quantity"
              className="tap-44 relative p-1.5 text-ink/60 transition-colors hover:text-ink"
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
        // mr-1, not -mr-1. The 44px target reaches 22px either side of a 16px
        // icon, and a negative margin pushed that past the panel's own padding —
        // at 320px, 15px of the target fell outside the viewport and was simply
        // unclickable. Nudging the icon inward keeps the whole target on screen
        // at the narrowest size we support. The icon moves 12px; nothing else does.
        className="tap-44 relative -mt-1 mr-2 self-start p-1 text-ink/30 transition-colors hover:text-terracotta"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

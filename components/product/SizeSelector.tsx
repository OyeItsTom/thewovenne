"use client";

import { cn } from "@/lib/utils";
import type { ProductSize } from "@/lib/sizes";

/**
 * Size choice, with sold-out sizes shown rather than hidden.
 *
 * Hiding them removes the information a shopper actually wants — that the size
 * exists and this product simply isn't available in it. A struck-through,
 * unclickable option answers "do you make my size?" and "is it in stock?"
 * separately; hiding conflates them into "we don't make it".
 */
export default function SizeSelector({
  sizes,
  selected,
  onSelect,
}: {
  sizes: ProductSize[];
  selected: string;
  onSelect: (size: string) => void;
}) {
  if (sizes.length === 0) return null;

  return (
    <div>
      <h3 className="font-heading text-sm uppercase tracking-wider text-ink/60">
        Size
      </h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {sizes.map((size) => {
          const soldOut = size.stock_quantity <= 0;
          const isSelected = selected === size.label;

          return (
            <button
              key={size.id}
              onClick={() => !soldOut && onSelect(size.label)}
              disabled={soldOut}
              aria-disabled={soldOut}
              // Spelled out for screen readers: the strike-through is visual
              // only, and "M, sold out" is the whole message.
              aria-label={soldOut ? `${size.label} — sold out` : size.label}
              title={soldOut ? "Sold out" : undefined}
              className={cn(
                "h-12 min-w-12 rounded-full border px-4 text-sm font-medium transition-colors",
                soldOut
                  ? "cursor-not-allowed border-ink/10 text-ink/30 line-through"
                  : isSelected
                    ? "border-ink bg-ink text-cream"
                    : "border-ink/15 text-ink hover:border-ink"
              )}
            >
              {size.label}
            </button>
          );
        })}
      </div>

      {sizes.every((s) => s.stock_quantity <= 0) && (
        <p className="mt-3 text-sm text-ink/60">
          Every size is sold out at the moment — more is on the loom.
        </p>
      )}
    </div>
  );
}

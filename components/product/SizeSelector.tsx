"use client";

import Link from "next/link";
import { cPath } from "@/lib/country";
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
      {/* The size guide belongs HERE, beside the choice, not only in the footer
          where it already lives. This is the one moment somebody wants it, and
          leaving to hunt for it in the footer is how a considered purchase turns
          into a closed tab.

          A quiet text link rather than a button: it is a reference, not a step
          in buying, and it should not compete with the sizes themselves.

          Rendered only when there are sizes — the whole component returns null
          otherwise, so a saree never offers a size chart it has no use for. */}
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-heading text-sm uppercase tracking-wider text-ink/60">
          Size
        </h3>
        <Link
          href={cPath("/size-guide")}
          className="text-xs uppercase tracking-wider text-ink/55 underline decoration-ink/20 underline-offset-4 transition-colors hover:text-terracotta"
        >
          Size guide
        </Link>
      </div>
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

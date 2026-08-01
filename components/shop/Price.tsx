import type { Product } from "@/lib/types";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * A product's price, with the pre-discount figure struck through when a
 * campaign is running.
 *
 * Deliberately quiet: the old price is small and muted, the new one keeps the
 * same weight it always had, and there is no badge, banner or sale colour. A
 * discount should read as a fact about the price, not an advertisement.
 */
export default function Price({
  product,
  className,
  size = "sm",
}: {
  product: Product;
  className?: string;
  size?: "sm" | "lg";
}) {
  const { price, wasPrice, active } = effectivePrice(product);

  if (!active || wasPrice == null) {
    return (
      <span
        className={cn(
          size === "lg" ? "text-2xl" : "text-sm",
          "text-ink",
          className
        )}
      >
        {formatINR(price)}
      </span>
    );
  }

  return (
    <span className={cn("flex items-baseline gap-2", className)}>
      <span className={cn(size === "lg" ? "text-2xl" : "text-sm", "text-ink")}>
        {formatINR(price)}
      </span>
      <span
        className={cn(
          size === "lg" ? "text-base" : "text-xs",
          "text-ink/40 line-through"
        )}
      >
        {formatINR(wasPrice)}
      </span>
    </span>
  );
}

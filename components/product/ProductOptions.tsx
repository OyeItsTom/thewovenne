"use client";

import { useEffect, useRef, useState } from "react";
import type { Product } from "@/lib/types";
import type { ProductSize } from "@/lib/sizes";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import SizeSelector from "./SizeSelector";
import AddToCart from "./AddToCart";
import { effectivePrice } from "@/lib/pricing";
import { sizeStockNote } from "@/lib/stock";

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

  // FOLLOWS THE SELECTION, because that is the only stock number that means
  // anything once a size is chosen: "almost gone" across a product is not what
  // somebody buying an M needs to know. Null for a healthy size and null for a
  // sold-out one — sold out is said by the selector and the button, and saying it
  // three times does not make it truer. lib/stock owns the threshold.
  const sizeNote = selected ? sizeStockNote(selected.stock_quantity, selected.label) : null;

  /**
   * The sticky bar appears only once the real Add to Cart has been seen and then
   * left the screen.
   *
   * It used to be `fixed` unconditionally, so it was on screen from the moment
   * the page loaded — covering 69px of an 844px phone before the customer had
   * seen anything, offering a second price and a second Add button, and asking
   * somebody to buy a size they had not chosen yet.
   *
   * "SEEN, THEN GONE" RATHER THAN "NOT CURRENTLY VISIBLE", and the difference is
   * not academic. The real button sits around 1233px down a 390px-wide page, so
   * it is already outside the viewport on load. A plain !isIntersecting test
   * would therefore show the bar immediately — reintroducing the exact problem,
   * just via an observer. The bar has to wait until the customer has actually
   * reached the purchase controls once.
   *
   * After that it behaves normally: away when the real button is on screen,
   * back when it is not.
   *
   * No scroll listener, no threshold guessing, no library.
   */
  const ctaRef = useRef<HTMLDivElement>(null);
  const [ctaVisible, setCtaVisible] = useState(false);
  const [ctaHasBeenSeen, setCtaHasBeenSeen] = useState(false);

  useEffect(() => {
    const node = ctaRef.current;
    if (!node) return;

    // No IntersectionObserver — an old browser, or a test environment. Never
    // showing the bar is the safe failure: the page still has its real button,
    // and a permanently pinned bar is the thing being fixed.
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setCtaVisible(entry.isIntersecting);
        if (entry.isIntersecting) setCtaHasBeenSeen(true);
      },
      // The bottom of the viewport is trimmed by roughly the bar's own height,
      // so the bar cannot appear while it would be sitting on top of the button
      // it is standing in for.
      { rootMargin: "0px 0px -80px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const showStickyBar = ctaHasBeenSeen && !ctaVisible;

  return (
    <div className="space-y-6">
      <SizeSelector sizes={sizes} selected={size} onSelect={setSize} />

      {sizeNote && (
        /* Beside the size and above the button — the buying decision, not the
           photography. Small caps and a gold hairline, the same voice the page
           uses for the one-size note. No red, no animation, no countdown. */
        <p className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-ink/60">
          <span aria-hidden className="h-1 w-1 rounded-full bg-gold" />
          {sizeNote}
        </p>
      )}
      <div ref={ctaRef}>
        <AddToCart
          product={product}
          size={size}
          disabled={outOfStock}
          available={sizes.length > 0 ? (selected?.stock_quantity ?? 0) : undefined}
        />
      </div>

      {/* Sticky add-to-cart bar — mobile only, and only once the real button has
          scrolled away. Adds one of the selected size. */}
      {/* pr-24 clears the floating WhatsApp button at bottom-right. */}
      {showStickyBar && (
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
      )}
    </div>
  );
}

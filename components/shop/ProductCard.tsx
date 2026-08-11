"use client";

import { useState } from "react";
// Type-only: React exports this as a type, not a value, and importing it as a
// value binding is a runtime error under isolatedModules.
import type { MouseEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { Product } from "@/lib/types";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import { productHref } from "@/lib/urls";
import WishlistButton from "./WishlistButton";
import { useReveal, revealClass } from "@/lib/useReveal";
import { useCartStore } from "@/lib/store";
import { stockState } from "@/lib/stock";

export default function ProductCard({ product }: { product: Product }) {
  const { ref, revealed } = useReveal<HTMLDivElement>();

  // ── The photographs ───────────────────────────
  // MANUAL ONLY. #108 changed the image when a mouse arrived; nothing changes it
  // now except a customer pressing an arrow. No timer, no hover switch, no
  // advance on entering the viewport, and no reset — the card stays exactly
  // where it was left.
  //
  // `index` is per card, held here rather than anywhere shared, so pressing next
  // on one product cannot move another. It starts at 0 and stays there until
  // somebody asks for something else.
  const images = product.images?.length ? product.images : product.image_url ? [product.image_url] : [];
  const [index, setIndex] = useState(0);

  // Only photographs the customer has actually asked for are mounted. A hidden
  // <Image> that is merely transparent still downloads once it scrolls into
  // view, so rendering the whole gallery would put every secondary photograph of
  // every product on the wire for a visitor who never presses an arrow — the
  // cost #108 was careful to avoid, and the reason this grows rather than
  // rendering images.map().
  const [mounted, setMounted] = useState(0);

  const step = (delta: number) => (e: MouseEvent) => {
    // The card is a link. Without both of these, changing the photograph would
    // open the product page instead.
    e.preventDefault();
    e.stopPropagation();
    const next = index + delta;
    if (next < 0 || next >= images.length) return;
    setIndex(next);
    setMounted((m) => Math.max(m, next));
  };

  const hasMany = images.length > 1;
  const atStart = index === 0;
  const atEnd = index === images.length - 1;

  const addItem = useCartStore((s) => s.addItem);
  const openCart = useCartStore((s) => s.openCart);

  // THE ONE INTERPRETATION OF INVENTORY. This used to carry its own rule —
  // `stock_quantity <= 5` — a second opinion that disagreed with the product
  // page's threshold of three. Post-0056 the column IS the derived total for a
  // sized product, so asking lib/stock about it gives a card the same answer the
  // page gives, by construction rather than by coincidence.
  const stock = stockState(product.stock_quantity);
  const outOfStock = stock.soldOut;
  // The campaign price, so the card, the cart and the charge all agree. The
  // server re-resolves this at checkout regardless — see the checkout route.
  const { price, wasPrice } = effectivePrice(product);

  const handleQuickAdd = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({
      id: product.id,
      slug: product.slug,
      name: product.name,
      price_inr: price,
      image_url: product.image_url,
      size: "One Size",
    });
    openCart();
  };

  return (
    <div ref={ref} className={`group ${revealClass(revealed)}`}>
      <Link href={productHref(product)} className="block">
        <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-linen">
          {/* THE COVER IS ALWAYS THE BASE LAYER, at full opacity, and every
              other photograph fades in on top of it. That is what stops a blank
              frame: a chosen image that has not downloaded yet simply has not
              covered the cover yet, rather than replacing it with nothing. */}
          {images[0] && (
            <Image
              src={images[0]}
              alt={product.name}
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
              className="object-cover transition-transform duration-700 group-hover:scale-105"
            />
          )}

          {images.slice(1, mounted + 1).map((src, i) => (
            <Image
              key={src}
              src={src}
              alt=""
              aria-hidden
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
              className={`object-cover transition-opacity duration-300 ease-out group-hover:scale-105 motion-reduce:transition-none ${
                index === i + 1 ? "opacity-100" : "opacity-0"
              }`}
            />
          ))}

          {/* ── Manual navigation ──
              Only when there is somewhere to go. Quiet and small — a scaled-down
              version of the product gallery's arrows (#109), not a slideshow
              control: same chevron, same cream disc, roughly two thirds the
              size, and sitting inside the frame rather than over the middle of
              the garment.

              Visible on touch, where there is no hover to reveal them, and on
              hover or keyboard focus on a pointer device. Disabled rather than
              hidden at the ends, so the card does not reflow as somebody steps
              through, and so nothing is offered that would do nothing. */}
          {hasMany && (
            <>
              <button
                type="button"
                onClick={step(-1)}
                disabled={atStart}
                aria-label={`Previous image of ${product.name}`}
                className="tap-44 absolute left-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink shadow-soft backdrop-blur transition-opacity duration-300 disabled:opacity-25 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={step(1)}
                disabled={atEnd}
                aria-label={`Next image of ${product.name}`}
                className="tap-44 absolute right-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink shadow-soft backdrop-blur transition-opacity duration-300 disabled:opacity-25 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          )}

          <WishlistButton
            productId={product.id}
            productName={product.name}
            size="sm"
            className="absolute right-3 top-3 z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100 focus-visible:opacity-100 md:opacity-0"
          />

          {/* NO LOW-STOCK COPY ON A DISCOVERY CARD. "Only 2 left" scattered
              across a grid is scarcity used as decoration: it competes with the
              photograph, and it reads as a marketplace rather than a shop. That
              sentence belongs where somebody is deciding to buy — beside the
              size and the button — not where they are still looking.

              SOLD OUT STAYS, because it is not urgency, it is the answer to
              "can I buy this?" — and a customer who clicks through to find out
              has been wasted. Quiet type on cream rather than a red badge. */}
          {outOfStock && (
            <span className="absolute left-3 top-3 rounded-full bg-cream/90 px-3 py-1 text-[11px] uppercase tracking-wider text-ink/70 backdrop-blur">
              Sold out
            </span>
          )}

          {!outOfStock && (
            <button
              onClick={handleQuickAdd}
              aria-label={`Quick add ${product.name} to cart`}
              className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-cream text-ink opacity-0 shadow-soft transition-all duration-300 group-hover:opacity-100 hover:bg-terracotta hover:text-cream focus-visible:opacity-100"
            >
              <Plus className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="mt-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="font-heading text-lg leading-tight text-ink">
              {product.name}
            </h3>
            {product.category && (
              <p className="mt-0.5 text-xs uppercase tracking-wider text-ink/50">
                {product.category}
              </p>
            )}
          </div>
          <span className="flex items-baseline gap-2 whitespace-nowrap font-body text-sm font-medium">
            <span className="text-ink">{formatINR(price)}</span>
            {wasPrice != null && (
              <span className="text-xs font-normal text-ink/40 line-through">
                {formatINR(wasPrice)}
              </span>
            )}
          </span>
        </div>
      </Link>
    </div>
  );
}

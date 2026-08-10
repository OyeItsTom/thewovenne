"use client";

import { useState } from "react";
// Type-only: React exports these as types, not values, and importing them as
// value bindings is a runtime error under isolatedModules.
import type { MouseEvent, PointerEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { Plus } from "lucide-react";
import type { Product } from "@/lib/types";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import { productHref } from "@/lib/urls";
import WishlistButton from "./WishlistButton";
import { useReveal, revealClass } from "@/lib/useReveal";
import { useCartStore } from "@/lib/store";
import Badge from "@/components/ui/Badge";

export default function ProductCard({ product }: { product: Product }) {
  const { ref, revealed } = useReveal<HTMLDivElement>();

  // ── The second photograph ──────────────────────
  // `armed` is one-way: once a mouse has been over this card the image stays
  // mounted, so leaving and returning does not re-request it. `hovering` is what
  // actually cross-fades. Splitting the two is the whole trick — a single state
  // would either re-download on every pass or download for everybody.
  //
  // NOTHING IS FETCHED UNTIL A MOUSE ARRIVES. A hidden <Image> that is merely
  // transparent still downloads when it scrolls into view, which would put a
  // second photograph of every product on the wire for a visitor who never
  // hovers — the opposite of the point.
  const [armed, setArmed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [hoverLoaded, setHoverLoaded] = useState(false);
  const hoverSrc = product.hover_image_url ?? null;

  // Touch fires pointerenter too, and on a phone a tap means "open this
  // product", not "show me the other angle". Mouse only, deliberately: see the
  // brief — a swipe on a card fights the page's own vertical scroll.
  const onPointerEnter = (e: PointerEvent) => {
    if (!hoverSrc || e.pointerType !== "mouse") return;
    setArmed(true);
    setHovering(true);
  };
  const addItem = useCartStore((s) => s.addItem);
  const openCart = useCartStore((s) => s.openCart);

  const outOfStock = product.stock_quantity <= 0;
  // The campaign price, so the card, the cart and the charge all agree. The
  // server re-resolves this at checkout regardless — see the checkout route.
  const { price, wasPrice } = effectivePrice(product);
  const lowStock = product.stock_quantity > 0 && product.stock_quantity <= 5;

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
    <div
      ref={ref}
      className={`group ${revealClass(revealed)}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={() => setHovering(false)}
    >
      <Link href={productHref(product)} className="block">
        <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-linen">
          {product.image_url && (
            <Image
              src={product.image_url}
              alt={product.name}
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
              className="object-cover transition-transform duration-700 group-hover:scale-105"
            />
          )}

          {/* The cross-fade. Held at opacity-0 until the file has actually
              arrived, so a slow connection shows the cover a moment longer
              rather than a half-drawn photograph. Decorative: the card is
              already labelled by the product name below it. */}
          {armed && hoverSrc && (
            <Image
              src={hoverSrc}
              alt=""
              aria-hidden
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
              onLoad={() => setHoverLoaded(true)}
              className={`object-cover transition-[opacity,transform] duration-700 ease-out group-hover:scale-105 motion-reduce:transition-none ${
                hovering && hoverLoaded ? "opacity-100" : "opacity-0"
              }`}
            />
          )}

          <WishlistButton
            productId={product.id}
            productName={product.name}
            size="sm"
            className="absolute right-3 top-3 z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100 focus-visible:opacity-100 md:opacity-0"
          />

          {outOfStock ? (
            <Badge tone="danger" className="absolute left-3 top-3">
              Out of Stock
            </Badge>
          ) : lowStock ? (
            <Badge tone="warning" className="absolute left-3 top-3">
              Only {product.stock_quantity} left
            </Badge>
          ) : null}

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

"use client";

import { useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ProductListing } from "@/lib/types";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import { productHref } from "@/lib/urls";
import { decideCardGesture } from "@/lib/cardSwipe";
import WishlistButton from "./WishlistButton";
import { useReveal, revealClass } from "@/lib/useReveal";
import { stockState } from "@/lib/stock";

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  multiTouch: boolean;
}

const EDGE_GESTURE_GUTTER = 20;

export default function ProductCard({ product }: { product: ProductListing }) {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  const images = product.images?.length
    ? product.images
    : product.image_url
      ? [product.image_url]
      : [];
  const [index, setIndex] = useState(0);
  const [mounted, setMounted] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);

  const hasMany = images.length > 1;
  const atStart = index === 0;
  const atEnd = index === images.length - 1;
  const stock = stockState(product.stock_quantity);
  const { price, wasPrice } = effectivePrice(product);

  const show = (next: number) => {
    if (next === index || next < 0 || next >= images.length) return;
    setMounted((current) => Math.max(current, next));
    setIndex(next);
  };

  const step = (delta: number) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    show(index + delta);
  };

  const onPointerDown = (event: PointerEvent<HTMLAnchorElement>) => {
    suppressClick.current = false;
    if (event.pointerType === "mouse") return;
    if (!event.isPrimary || gesture.current) {
      if (gesture.current) gesture.current.multiTouch = true;
      return;
    }
    // Leave the system's edge-back gesture alone. The catalogue reaches the
    // viewport edge on mobile, so claiming those first pixels would be rude.
    if (
      event.clientX <= EDGE_GESTURE_GUTTER ||
      event.clientX >= window.innerWidth - EDGE_GESTURE_GUTTER
    ) {
      return;
    }
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      endX: event.clientX,
      endY: event.clientY,
      multiTouch: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLAnchorElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // Refs only: dragging a card never asks React to render every pointer move.
    current.endX = event.clientX;
    current.endY = event.clientY;
  };

  const finishGesture = (event: PointerEvent<HTMLAnchorElement>, cancelled = false) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.endX = event.clientX;
    current.endY = event.clientY;
    const decision = decideCardGesture({
      ...current,
      index,
      imageCount: images.length,
      cancelled,
    });
    gesture.current = null;
    suppressClick.current = decision.suppressClick;
    if (decision.kind === "swipe") show(decision.nextIndex);
  };

  const onPhotoClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
  };

  return (
    <article ref={ref} className={`group min-w-0 ${revealClass(revealed)}`}>
      <div className="relative aspect-[4/5] overflow-hidden bg-linen sm:rounded-xl">
        <Link
          href={productHref(product)}
          aria-label={`View ${product.name}`}
          className="absolute inset-0 block touch-pan-y focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-terracotta"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finishGesture(event)}
          onPointerCancel={(event) => finishGesture(event, true)}
          onClick={onPhotoClick}
        >
          {images[0] && (
            <Image
              src={images[0]}
              alt={product.name}
              fill
              sizes="(max-width: 639px) 50vw, (max-width: 1023px) 33vw, 25vw"
              className="object-cover transition-transform duration-700 md:group-hover:scale-[1.025] motion-reduce:transition-none"
            />
          )}
          {images.slice(1, mounted + 1).map((src, imageIndex) => (
            <Image
              key={src}
              src={src}
              alt=""
              aria-hidden
              fill
              sizes="(max-width: 639px) 50vw, (max-width: 1023px) 33vw, 25vw"
              className={`object-cover transition-opacity duration-300 motion-reduce:transition-none ${
                index === imageIndex + 1 ? "opacity-100" : "opacity-0"
              }`}
            />
          ))}
        </Link>

        {hasMany && (
          <>
            <button
              type="button"
              onClick={step(-1)}
              disabled={atStart}
              aria-label={`Previous image of ${product.name}`}
              className="tap-44 pointer-events-none absolute left-1 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink opacity-0 shadow-soft backdrop-blur transition-opacity disabled:opacity-0 md:left-2 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={step(1)}
              disabled={atEnd}
              aria-label={`Next image of ${product.name}`}
              className="tap-44 pointer-events-none absolute right-1 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink opacity-0 shadow-soft backdrop-blur transition-opacity disabled:opacity-0 md:right-2 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </>
        )}

        <WishlistButton
          productId={product.id}
          productName={product.name}
          size="sm"
          className="absolute right-2 top-2 z-30 bg-cream/75 shadow-none md:right-3 md:top-3 md:opacity-0 md:shadow-soft md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100"
        />
      </div>

      <div className="px-2 pb-1 pt-2 sm:px-0 sm:pt-3">
        <Link href={productHref(product)} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta">
          <h3 className="line-clamp-2 min-h-10 font-heading text-base leading-5 text-ink sm:min-h-0 sm:text-lg sm:leading-tight">
            {product.name}
          </h3>
        </Link>
        <div className="mt-1 flex min-w-0 items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap font-body text-sm font-medium text-ink">
            {formatINR(price)}
            {wasPrice != null && (
              <span className="text-[11px] font-normal text-ink/45 line-through">
                {formatINR(wasPrice)}
              </span>
            )}
          </span>
          {stock.soldOut && (
            <span className="text-[10px] uppercase tracking-wider text-ink/55">
              Sold out
            </span>
          )}
        </div>
      </div>

      {hasMany && (
        <p className="sr-only" role="status" aria-live="polite">
          Image {index + 1} of {images.length} for {product.name}
        </p>
      )}
    </article>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ProductListing } from "@/lib/types";
import { formatINR } from "@/lib/utils";
import { effectivePrice } from "@/lib/pricing";
import { productHref } from "@/lib/urls";
import { cardImageOffset, decideCardGesture } from "@/lib/cardSwipe";
import { nextPeekStage, type PeekStage } from "@/lib/cardPeek";
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

/**
 * What a card photograph is ACTUALLY as wide as, at each layout.
 *
 * The last clause is the one that matters. `25vw` was true only while the grid
 * kept growing with the window, and it stops growing at 1280: the container is
 * `max-w-7xl` (1280) with `lg:px-12` (48 a side) and `lg:gap-8` (32 between
 * four columns), so from 1280 up every card is exactly
 * (1280 − 96 − 96) / 4 = 272px and stays there. `25vw` on a 1920 monitor claims
 * 480px for a 272px card, and the browser dutifully fetches a variant nearly
 * twice the size it can display.
 *
 * The earlier clauses stay approximate on purpose — they overstate by the
 * gutters (12px on mobile, ~37px on tablet), which is the safe direction and
 * keeps the expression readable. Nothing here underserves a dense screen: at
 * 272px a 3x device asks for 816 and the 828 candidate is available.
 */
const CARD_SIZES =
  "(max-width: 639px) 50vw, (max-width: 1023px) 33vw, (max-width: 1279px) 25vw, 272px";

export default function ProductCard({
  product,
  discoveryHint = false,
}: {
  product: ProductListing;
  discoveryHint?: boolean;
}) {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  const images = product.images?.length
    ? product.images
    : product.image_url
      ? [product.image_url]
      : [];
  const imageCount = images.length;
  const [index, setIndex] = useState(0);
  const [mounted, setMounted] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const peekStageRef = useRef<PeekStage>("idle");
  const peekTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [peekStage, setPeekStage] = useState<PeekStage>("idle");

  const hasMany = images.length > 1;
  const atStart = index === 0;
  const atEnd = index === images.length - 1;
  const stock = stockState(product.stock_quantity);
  const { price, wasPrice } = effectivePrice(product);
  const imagePosition = (imageIndex: number) => {
    const offset = cardImageOffset(imageIndex, index);
    if (offset < 0) return "-translate-x-full";
    if (offset > 0) return "translate-x-full";
    return "translate-x-0";
  };

  const clearPeekTimers = useCallback(() => {
    peekTimers.current.forEach(clearTimeout);
    peekTimers.current = [];
  }, []);

  const movePeek = useCallback((action: Parameters<typeof nextPeekStage>[1]) => {
    const next = nextPeekStage(peekStageRef.current, action, {
      imageCount,
      reducedMotion: false,
    });
    peekStageRef.current = next;
    setPeekStage(next);
    if (next === "done") clearPeekTimers();
    return next;
  }, [clearPeekTimers, imageCount]);

  const cancelPeek = () => {
    if (peekStageRef.current !== "done") movePeek("interact");
  };

  const startPeekTimers = useCallback(() => {
    if (peekStageRef.current !== "waiting" || peekTimers.current.length > 0) return;
    peekTimers.current = [
      setTimeout(() => movePeek("timer"), 1100),
      setTimeout(() => movePeek("return"), 1700),
      setTimeout(() => movePeek("complete"), 2200),
    ];
  }, [movePeek]);

  useEffect(() => {
    const node = ref.current;
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const mobile = window.matchMedia?.("(max-width: 767px)").matches;
    if (!node || !discoveryHint || !mobile || imageCount <= 1 || reducedMotion) {
      peekStageRef.current = "done";
      setPeekStage("done");
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) {
          movePeek("hidden");
          return;
        }
        if (movePeek("visible") !== "waiting") return;

        // Only the one adjacent photograph required for the hint is prepared,
        // and only after this particular card is genuinely on screen.
        setMounted((current) => Math.max(current, 1));
      },
      { threshold: 0.55 }
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
      clearPeekTimers();
    };
  }, [clearPeekTimers, discoveryHint, imageCount, movePeek, ref]);

  const show = (next: number) => {
    if (next === index || next < 0 || next >= images.length) return;
    if (next > mounted) {
      setMounted(next);
      // Let the requested image mount just outside the frame before both
      // photographs move. Without this frame, a newly requested image appears
      // directly on top of the current one instead of entering from its side.
      requestAnimationFrame(() => requestAnimationFrame(() => setIndex(next)));
      return;
    }
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
    <article
      ref={ref}
      className={`group min-w-0 ${revealClass(revealed)}`}
      onPointerDownCapture={cancelPeek}
      onClickCapture={cancelPeek}
      onKeyDownCapture={cancelPeek}
    >
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
              sizes={CARD_SIZES}
              className={`object-cover transition-transform duration-500 ease-out motion-reduce:transition-none ${
                index > 0
                  ? imagePosition(0)
                  : peekStage === "peeking"
                    ? "-translate-x-[18%]"
                    : "translate-x-0 md:group-hover:scale-[1.025]"
              }`}
            />
          )}
          {images.slice(1, mounted + 1).map((src, imageIndex) => (
            <Image
              key={src}
              src={src}
              alt=""
              aria-hidden
              fill
              onLoad={imageIndex === 0 ? startPeekTimers : undefined}
              sizes={CARD_SIZES}
              className={`object-cover transition-transform duration-500 ease-out motion-reduce:transition-none ${
                imageIndex + 1 <= index
                  ? imagePosition(imageIndex + 1)
                    : imageIndex === 0 && peekStage === "peeking"
                      ? "translate-x-[82%]"
                      : "translate-x-full"
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

        {hasMany && (
          <div
            className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 gap-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]"
            aria-hidden="true"
            data-gallery-indicator
          >
            {images.map((_, dotIndex) => (
              <span
                key={dotIndex}
                className={`h-1 w-1 rounded-full transition-colors motion-reduce:transition-none ${
                  dotIndex === index ? "bg-white" : "bg-white/55"
                }`}
              />
            ))}
          </div>
        )}

        <WishlistButton
          productId={product.id}
          productName={product.name}
          size="sm"
          appearance="overlay"
          className="absolute right-2 top-2 z-30 md:right-3 md:top-3 md:bg-cream/85 md:text-ink md:opacity-0 md:shadow-soft md:backdrop-blur md:[filter:none] md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100"
        />
      </div>

      <div className="h-[76px] px-1 pb-1 pt-2 sm:h-auto sm:px-0 sm:pt-3">
        <Link href={productHref(product)} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta">
          <h3 className="line-clamp-2 min-h-9 font-body text-sm font-normal leading-[18px] tracking-[0.01em] text-ink sm:min-h-0 sm:text-base sm:leading-5">
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

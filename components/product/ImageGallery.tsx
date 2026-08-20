"use client";

import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import ImageWeaveOverlay from "@/components/weave/ImageWeaveOverlay";
import ImageViewer from "./ImageViewer";
import { cardImageOffset, decideCardGesture } from "@/lib/cardSwipe";

/**
 * The gallery.
 *
 * ONE IMAGE PER FRAME, SLID SIDEWAYS. Every photograph is rendered stacked and
 * moved as a set: the ones before the active image sit at -100%, the ones after
 * at +100%, the active one at 0. Changing angle therefore travels in the
 * direction you asked for, which is what makes a swipe feel like it moved the
 * picture rather than dissolved it.
 *
 * THIS REPLACED A CROSS-FADE, DELIBERATELY. A fade cannot express direction, so
 * a leftward swipe and a rightward swipe looked identical and the gallery read
 * as broken on a phone. Desktop gets the same slide rather than keeping the
 * fade, because one gallery with two different transitions is a bug that looks
 * like a decision.
 *
 * SWIPE IS THE MOBILE CONTROL; THE ARROWS ARE THE POINTER ONE. The buttons used
 * to be 44px cream discs sitting on the photograph at every width — two white
 * circles over the cloth on the device where you would never press them, because
 * you would swipe. They are gone below md and appear on hover or keyboard focus
 * above it, drawn as bare chevrons.
 *
 * NOBODY LOSES A ROUTE THROUGH THE SET. Swipe is an addition, never the only
 * way: the thumbnail strip, the arrow keys on the focused frame and the live
 * region below it all still work, and none of them depend on being able to make
 * a gesture.
 *
 * NO WRAP. `go` clamps instead of taking a modulo. Wrapping and direction
 * contradict each other — a "next" from the last image would slide the whole
 * set backwards — and at a boundary the honest answer is that there is nothing
 * further that way.
 */
export default function ImageGallery({
  images,
  alt,
}: {
  images: string[];
  alt: string;
}) {
  const [active, setActive] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [pointer, setPointer] = useState({ x: 0, y: 0, active: false });
  // A swipe on a touchscreen is followed by a synthetic click. Without this the
  // gesture that changed the photograph would also open the viewer.
  const suppressClick = useRef(false);
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    multiTouch: boolean;
  } | null>(null);

  // Clamped, not wrapped — see the note above.
  const go = (dir: number) =>
    setActive((i) => Math.max(0, Math.min(images.length - 1, i + dir)));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A mouse has the arrows and the thumbnails; dragging a photograph with one
    // is not a gesture anybody makes.
    if (event.pointerType === "mouse") return;
    if (!event.isPrimary || gesture.current) {
      // A second finger lands mid-gesture: this is a pinch or a two-finger
      // scroll, and neither should change the picture.
      if (gesture.current) gesture.current.multiTouch = true;
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

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The weave overlay wants every move; the gesture only wants the last one.
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top, active: true });

    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // Refs, not state: a drag never asks React to render once per pointer move.
    current.endX = event.clientX;
    current.endY = event.clientY;
  };

  const finishGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false
  ) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.endX = event.clientX;
    current.endY = event.clientY;
    // The same decision the product cards make: a 10px slop that is still a
    // tap, an axis bias so a diagonal follows its dominant direction, a 36px
    // minimum before anything moves, and a clamp at both ends.
    const decision = decideCardGesture({
      ...current,
      index: active,
      imageCount: images.length,
      cancelled,
    });
    gesture.current = null;
    suppressClick.current = decision.kind !== "tap";
    if (decision.kind === "swipe") setActive(decision.nextIndex);
    // A tap on the photograph is the way in to the viewer on a touchscreen —
    // there is no hover there to reveal a cue, and a picture you can tap to see
    // larger is the one convention every phone owner already has.
    if (decision.kind === "tap") setViewerOpen(true);
  };

  const onFrameClick = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    setViewerOpen(true);
  };

  // A product can legitimately have no photo yet — render the frame rather
  // than passing undefined to next/image.
  if (images.length === 0) {
    return (
      <div className="flex aspect-[4/5] w-full items-center justify-center rounded-2xl bg-linen text-sm text-ink/40">
        Photography coming soon
      </div>
    );
  }

  const atStart = active === 0;
  const atEnd = active === images.length - 1;

  /* Bare chevron, no disc. Shared by both arrows so they cannot drift apart. */
  const arrowClass =
    "tap-44 pointer-events-none absolute top-1/2 z-20 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-white opacity-0 transition-opacity [filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.8))] disabled:opacity-0 md:flex md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta";

  return (
    <div>
      <div
        role="group"
        aria-label={`${alt} — image ${active + 1} of ${images.length}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
          if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
        }}
        // touch-pan-y hands every vertical movement straight to the page, so
        // reading down a product never fights the gallery for the gesture.
        className="group relative aspect-[3/4] w-full cursor-zoom-in touch-pan-y overflow-hidden rounded-2xl bg-linen focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-terracotta/40"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onFrameClick}
        onPointerUp={(e) => finishGesture(e)}
        // A pointercancel is the system taking the gesture away (a notification,
        // an edge swipe). Treated as "nothing happened", never as a swipe.
        onPointerCancel={(e) => finishGesture(e, true)}
        onPointerLeave={(e) => {
          setPointer((p) => ({ ...p, active: false }));
          finishGesture(e, true);
        }}
      >
        {images.map((src, i) => {
          const offset = cardImageOffset(i, active);
          return (
            <Image
              key={src + i}
              src={src}
              alt={i === active ? alt : ""}
              aria-hidden={i !== active}
              fill
              // Only the cover is priority: it is the page's LCP. Its immediate
              // neighbours are eager because a slid-away image leaves the
              // viewport, and a lazy one would arrive as a blank frame halfway
              // through the swipe that asked for it. Everything further out
              // stays lazy — at most three files are ever in flight.
              priority={i === 0}
              loading={
                i === 0 ? undefined : Math.abs(i - active) <= 1 ? "eager" : "lazy"
              }
              sizes="(min-width: 1024px) 50vw, 100vw"
              className={cn(
                "object-cover transition-transform duration-500 ease-out motion-reduce:transition-none",
                offset < 0 && "-translate-x-full",
                offset > 0 && "translate-x-full",
                offset === 0 && "translate-x-0"
              )}
            />
          );
        })}
        {/* Interactive weave — the cloth reacts to your hand. */}
        <ImageWeaveOverlay pointer={pointer} />
        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); go(-1); }}
              disabled={atStart}
              aria-label="Previous image"
              className={cn(arrowClass, "left-3")}
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); go(1); }}
              disabled={atEnd}
              aria-label="Next image"
              className={cn(arrowClass, "right-3")}
            >
              <ChevronRight className="h-5 w-5" strokeWidth={1.5} />
            </button>

            {/* Where you are in the set, for anyone who does not want to count
                thumbnails. Bottom left, so it never sits under the arrows. */}
            <span className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-full bg-cream/80 px-3 py-1 text-xs tabular-nums text-ink/70 backdrop-blur">
              {active + 1} / {images.length}
            </span>
          </>
        )}

        {/* A cue, not a control: the whole photograph is already the target.
            It exists for pointer users, who have no tap convention to fall back
            on, and for keyboard users, who need something focusable to press.
            Invisible until hover or focus, and never on the way on a phone. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setViewerOpen(true); }}
          aria-label={`View ${alt} full screen`}
          className="tap-44 absolute bottom-3 right-3 z-20 flex h-9 w-9 items-center justify-center rounded-full text-white opacity-0 transition-opacity [filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.8))] md:group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
        >
          <ZoomIn className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>

      {/* Which image is showing, for anyone who cannot see that it changed —
          including after a swipe, which has no control to announce for it. */}
      {images.length > 1 && (
        <p className="sr-only" role="status" aria-live="polite">
          Image {active + 1} of {images.length}
        </p>
      )}

      {images.length > 1 && (
        // THE STRIP IS SHORTER ON A PHONE, and the main photograph is not
        // touched. At 390px the gallery is 453px tall and the strip added
        // another 101 on top, which together pushed the product's name to 828
        // and its price to 888 — past the 844 fold. A customer saw a photograph
        // and had to scroll to learn what it cost.
        //
        // Square thumbnails rather than 3:4 on mobile: a thumbnail's job is to
        // say "there is another angle", and it does that at any ratio. The
        // portrait crop that matters is the one in the main frame, and it is
        // unchanged. Above sm: the strip keeps its original proportions, where
        // there is room for them.
        <div className="mt-3 grid grid-cols-4 gap-3 sm:mt-4">
          {images.map((src, i) => (
            <button
              key={src + i}
              onClick={() => setActive(i)}
              aria-label={`View image ${i + 1} of ${images.length}`}
              aria-current={active === i}
              className={cn(
                "relative aspect-square overflow-hidden rounded-lg bg-linen transition-all duration-300 sm:aspect-[3/4]",
                // A hairline, not a coloured ring: the thumbnail strip should
                // read as part of the photograph, not as a control panel.
                active === i
                  ? "ring-1 ring-ink/40 ring-offset-2 ring-offset-cream"
                  : "opacity-60 hover:opacity-100"
              )}
            >
              <Image
                src={src}
                alt={`${alt} thumbnail ${i + 1}`}
                fill
                sizes="120px"
                className="object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {/* MOUNTED ONLY WHEN OPEN. This is what keeps the zoom-sized variant off
          the wire for every visitor who never asks to see the cloth closely. */}
      {viewerOpen && (
        <ImageViewer
          images={images}
          alt={alt}
          index={active}
          onIndexChange={setActive}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}

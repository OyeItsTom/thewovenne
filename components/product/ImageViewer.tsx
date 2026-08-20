"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FINE_POINTER_QUERY,
  MIN_ZOOM,
  clampPan,
  decideViewerGesture,
  doubleTapZoom,
  focalPan,
  maxZoomFor,
  pinchZoom,
  pointDistance,
  settleZoom,
  viewerSizes,
} from "@/lib/imageZoom";

/**
 * The product-inspection popup: the photograph brought closer, on the page it
 * belongs to.
 *
 * WHAT THIS REPLACED, AND WHY. The first version was `fixed inset-0` with an
 * opaque ground and a `flex-1` frame — which is a full-screen image page, not a
 * popup. Nothing of the product survived behind it, the photograph stretched to
 * the whole viewport, and it read as having navigated somewhere. It also asked
 * for a 1920 variant under a `sizes` the product page never uses, so the first
 * thing a customer saw was an empty frame waiting on a fresh download.
 *
 * SO THE STAGE IS THE SAME PHOTOGRAPH. Same 3:4 crop, same `object-cover`, and
 * — this is the part that makes it instant — the same `sizes` string as the PDP
 * frame. Same string means the same chosen variant means the same URL, which
 * the browser already has. The picture is simply there.
 *
 * THE DETAIL LAYER ARRIVES AFTERWARDS. A second copy at the 1920 ceiling loads
 * on top, transparent until ready, then fades in over an identical crop — so
 * nothing moves, nothing flashes, and the only difference is that there is now
 * more to look at. Until it lands, the magnifier and the pinch work on what is
 * already here rather than refusing to open.
 *
 * ONE ZOOM, ONE LANGUAGE. The photograph itself enlarges, on every device: a
 * double-click or a double-tap toggles it, a pinch drives it continuously, and
 * a drag pans it once it is larger than its frame. A circular cursor-following
 * magnifier lived here briefly and is gone — it was a second way of looking at a
 * picture, and one is better. There is a single scale and a single offset in
 * this component; nothing keeps a competing zoom state per input.
 *
 * None of it is the accessible route: arrow keys, a focus trap and a live region
 * work regardless of what is in your hand.
 */
/** How long after a tap a second one still counts as a double. See finish(). */
const DOUBLE_TAP_MS = 400;

export default function ImageViewer({
  images,
  alt,
  index,
  onIndexChange,
  onClose,
  /** The PDP frame's own `sizes`. Passed in so the two cannot drift apart. */
  baseSizes,
}: {
  images: string[];
  alt: string;
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  baseSizes: string;
}) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [finePointer, setFinePointer] = useState(false);

  /** The 1920 copy of the CURRENT image, once it has arrived. */
  const [detail, setDetail] = useState<{
    src: string;
    naturalWidth: number;
  } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef({ x: 0, y: 0, offX: 0, offY: 0, dist: 0, zoom: 1, multi: false });
  const lastTap = useRef(0);

  const hasMany = images.length > 1;
  const atStart = index === 0;
  const atEnd = index === images.length - 1;
  const src = images[index];
  const detailReady = detail?.src === src;

  const stage = () =>
    stageRef.current?.getBoundingClientRect() ??
    ({ width: 0, height: 0, left: 0, top: 0 } as DOMRect);

  /* ------------------------------------------------------------ capabilities */

  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const pointer = window.matchMedia?.(FINE_POINTER_QUERY);
    setReduced(!!motion?.matches);
    setFinePointer(!!pointer?.matches);
    // Watched, not read once: pairing a mouse with a tablet flips this
    // mid-session, and the viewer should change instrument when it does.
    const onPointerChange = (e: MediaQueryListEvent) => setFinePointer(e.matches);
    pointer?.addEventListener?.("change", onPointerChange);
    return () => pointer?.removeEventListener?.("change", onPointerChange);
  }, []);

  /* --------------------------------------------------------------- lifecycle */

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    // overflow alone, deliberately: `position: fixed` on the body would scroll
    // the page to the top and land the customer somewhere else on close.
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    const restore = () => {
      setTimeout(() => {
        const node = dialogRef.current;
        if (node && !node.contains(document.activeElement)) closeRef.current?.focus();
      }, 0);
    };
    const onFocusIn = (e: FocusEvent) => {
      const node = dialogRef.current;
      if (node && !node.contains(e.target as Node)) restore();
    };
    // Both, because they describe different escapes: `focusin` catches focus
    // landing on something outside, `focusout` catches it falling to <body>,
    // which fires no focusin at all.
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", restore);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", restore);
    };
  }, []);

  /* -------------------------------------------------------------- navigation */

  /** Fitted, exactly: scale 1 and no translation, with nothing left over. */
  const reset = useCallback(() => {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, []);

  const go = useCallback(
    (dir: number) => {
      const next = Math.max(0, Math.min(images.length - 1, index + dir));
      if (next === index) return;
      reset();
      onIndexChange(next);
    },
    [images.length, index, onIndexChange, reset]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); return; }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  /* ------------------------------------------------------- pinch/pan (touch) */

  // How far this photograph can honestly be enlarged, from the variant that
  // actually arrived. Until it does, the floor — never a refusal to zoom.
  const maxZoom = detailReady
    ? maxZoomFor({
        naturalWidth: detail.naturalWidth,
        displayedWidth: stage().width,
        dpr: typeof window !== "undefined" ? window.devicePixelRatio : 1,
      })
    : maxZoomFor({ naturalWidth: 0, displayedWidth: stage().width });

  /** Continuous zoom (pinch). Settles to EXACTLY fitted, leaving no residue. */
  const setZoomTo = useCallback(
    (next: number) => {
      const z = settleZoom(next, maxZoom);
      setZoom(z);
      setOffset((o) => {
        if (z === MIN_ZOOM) return { x: 0, y: 0 };
        const rect = stage();
        return clampPan({
          x: o.x,
          y: o.y,
          zoom: z,
          frameWidth: rect.width,
          frameHeight: rect.height,
        });
      });
    },
    [maxZoom]
  );

  /**
   * The toggle, shared by double-click and double-tap.
   *
   * ONE PATH FOR BOTH, so the two gestures cannot drift into different states.
   * `x`/`y` are stage coordinates and steer the zoom toward what was actually
   * pointed at; going back to fitted ignores them and lands on dead centre.
   */
  const toggleZoomAt = useCallback(
    (x: number, y: number) => {
      const rect = stage();
      const target = settleZoom(doubleTapZoom(zoom, maxZoom), maxZoom);
      setZoom(target);
      setOffset(
        focalPan({
          pointerX: x,
          pointerY: y,
          stageWidth: rect.width,
          stageHeight: rect.height,
          fromZoom: zoom,
          toZoom: target,
          offsetX: offset.x,
          offsetY: offset.y,
        })
      );
    },
    [maxZoom, offset.x, offset.y, zoom]
  );

  /**
   * Desktop. The browser's own dblclick rather than a hand-rolled timer: it
   * already knows what a double-click is, including how far the mouse may
   * wander between the two, and a single click deliberately does nothing.
   */
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!finePointer) return;
    const rect = stage();
    toggleZoomAt(e.clientX - rect.left, e.clientY - rect.top);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // A mouse is tracked too, so a magnified photograph can be dragged. What a
    // mouse never does is navigate the gallery or trigger the zoom toggle —
    // those are the chevrons and dblclick respectively (see finish()).
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      start.current = {
        ...start.current,
        dist: pointDistance(a, b),
        zoom,
        offX: offset.x,
        offY: offset.y,
        multi: true,
      };
      return;
    }
    if (pointers.current.size > 2) { start.current.multi = true; return; }
    start.current = {
      x: e.clientX, y: e.clientY,
      offX: offset.x, offY: offset.y,
      dist: 0, zoom, multi: false,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      setZoomTo(
        pinchZoom({
          startDistance: start.current.dist,
          currentDistance: pointDistance(a, b),
          startZoom: start.current.zoom,
          max: maxZoom,
        })
      );
      return;
    }
    // Only a magnified photograph moves under the finger. Fitted, the drag is
    // being measured for a swipe and the picture stays where it is.
    if (zoom <= MIN_ZOOM + 0.01) return;
    const rect = stage();
    setOffset(
      clampPan({
        x: start.current.offX + (e.clientX - start.current.x),
        y: start.current.offY + (e.clientY - start.current.y),
        zoom,
        frameWidth: rect.width,
        frameHeight: rect.height,
      })
    );
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const had = pointers.current.has(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) return;
    setDragging(false);
    if (!had) return;

    const multi = start.current.multi;
    start.current.multi = false;
    if (multi) return;

    const decision = decideViewerGesture({
      zoom,
      startX: start.current.x,
      startY: start.current.y,
      endX: e.clientX,
      endY: e.clientY,
      index,
      imageCount: images.length,
      cancelled,
    });

    // Swiping between photographs is a touch gesture. A mouse has the chevrons
    // and the arrow keys, and a stray drag across the picture should not move
    // the gallery under it.
    if (decision.kind === "navigate") {
      if (e.pointerType !== "mouse") go(decision.nextIndex - index);
      return;
    }
    if (decision.kind !== "tap") return;
    // Desktop taps are handled by the browser's dblclick; running the timer
    // here as well would toggle twice for one double-click.
    if (e.pointerType === "mouse") return;

    const now = Date.now();
    // 400ms, not the conventional 300. Two taps are separated by whatever the
    // main thread is doing between them, and the main thread here may be
    // decoding a 1.1MB inspection photograph — enough jank to stretch a
    // deliberate double-tap past 300ms and drop it. Observed exactly once, on a
    // cold cache. A single tap does nothing else in this viewer, so a slightly
    // generous window costs nothing and a missed one costs the gesture.
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      // Zoom toward the tapped point — and this is now REACHABLE while zoomed,
      // which is what the old ordering made impossible.
      const rect = stage();
      toggleZoomAt(e.clientX - rect.left, e.clientY - rect.top);
    } else {
      lastTap.current = now;
    }
  };

  /* ------------------------------------------------------------------ render */

  const zoomed = zoom > MIN_ZOOM + 0.01;
  const navClass =
    "tap-44 pointer-events-none absolute top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-white opacity-0 transition-opacity [filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.85))] disabled:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} — closer look`}
      className="fixed inset-0 z-[70] flex items-center justify-center"
    >
      {/*
        The product page stays visible through this. Ink at 45% with a light
        blur is the site's own overlay treatment (components/ui/Modal), not a
        gallery blackout — the customer should still see the piece they were
        reading about.
      */}
      <div
        className="absolute inset-0 bg-ink/45 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />

      {/*
        THE STAGE. Height-led, because the photograph is 3:4 and a screen is
        not: the binding dimension is nearly always vertical, so the width
        follows from it and the margins take care of themselves. Mobile takes
        nearly the whole viewport; a desktop keeps deliberate margins so the
        page stays legible around it. dvh rather than vh so mobile browser
        chrome cannot crop the bottom of the picture.
      */}
      <div
        ref={stageRef}
        className={cn(
          // .inspect-stage derives the width so this 3:4 box fits BOTH axes;
          // see app/globals.css for why a max-width cap is not enough.
          "inspect-stage group relative aspect-[3/4] overflow-hidden rounded-2xl bg-linen",
          // TOUCH-ACTION IS OURS ON A TOUCHSCREEN, AT EVERY ZOOM LEVEL.
          // Conditioning this on `zoomed` looked tidier and broke both
          // gestures: at 1x the browser claimed the touch for its own panning
          // and cancelled the pointer stream, so a pinch never started and a
          // swipe arrived as `pointercancel`. Nothing is stolen from the
          // customer by taking it — the page beneath is scroll-locked while the
          // popup is open, and this applies to the stage alone.
          !finePointer && "touch-none",
          // The only visual hint that zoom exists. No icon, no overlay, no
          // instructional text — the cursor is enough, and it is free.
          finePointer && (zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in")
        )}
        style={{
          marginTop: "env(safe-area-inset-top)",
          marginBottom: "env(safe-area-inset-bottom)",
        }}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={(e) => finish(e, true)}
      >
        <div
          className={cn(
            "absolute inset-0",
            !dragging && !reduced && "transition-transform duration-200 ease-out",
            reduced && "transition-none"
          )}
          style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }}
        >
          {/*
            LAYER ONE — already in the browser. Identical src, identical crop and
            identical `sizes` to the product page's own frame, so this resolves
            to a variant that has been downloaded and decoded already. It is what
            makes the popup appear rather than load.
          */}
          <Image
            key={`base-${src}`}
            src={src}
            alt={alt}
            fill
            sizes={baseSizes}
            priority
            className="object-cover"
          />

          {/*
            LAYER TWO — the inspection copy, for THIS image only. Transparent
            until it has decoded, then faded in over an identical crop, so the
            upgrade is invisible except in what you can now see. No spinner: the
            photograph is already on screen, and a spinner over a visible picture
            reports on something the customer is not waiting for.
          */}
          <Image
            key={`detail-${src}`}
            src={src}
            alt=""
            aria-hidden="true"
            fill
            sizes={viewerSizes()}
            className={cn(
              "object-cover",
              detailReady ? "opacity-100" : "opacity-0",
              reduced ? "transition-none" : "transition-opacity duration-300"
            )}
            onLoad={(e) => {
              // naturalWidth is a TRUE pixel count here only because this
              // layer's `sizes` is a fixed px value (see lib/imageZoom); the
              // zoom ceiling is a ratio against it.
              const img = e.currentTarget;
              setDetail({ src, naturalWidth: img.naturalWidth });
            }}
          />
        </div>

        {hasMany && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); go(-1); }}
              disabled={atStart}
              aria-label="Previous image"
              className={cn(navClass, "left-2 sm:left-3")}
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); go(1); }}
              disabled={atEnd}
              aria-label="Next image"
              className={cn(navClass, "right-2 sm:right-3")}
            >
              <ChevronRight className="h-5 w-5" strokeWidth={1.5} />
            </button>

            <span
              className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 font-body text-xs tabular-nums tracking-widest text-white/70 [filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.8))]"
              aria-hidden="true"
            >
              {index + 1} / {images.length}
            </span>
          </>
        )}

        <button
          ref={closeRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close closer look"
          className="tap-44 absolute right-2 top-2 z-30 flex h-9 w-9 items-center justify-center rounded-full text-white [filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.85))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 sm:right-3 sm:top-3"
        >
          <X className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </div>

      {/*
        Position for anyone who cannot see the counter. Zoom deliberately
        announces nothing: it changes with every pinch frame, and narrating a
        scale factor is noise rather than information.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        Image {index + 1} of {images.length}
      </p>
    </div>
  );
}

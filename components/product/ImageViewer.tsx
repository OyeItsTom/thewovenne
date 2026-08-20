"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MIN_ZOOM,
  clampPan,
  clampZoom,
  containedWidth,
  decideViewerGesture,
  doubleTapZoom,
  maxZoomFor,
  pinchZoom,
  pointDistance,
  viewerSizes,
  wheelZoom,
} from "@/lib/imageZoom";

/**
 * Full-screen product-image viewer.
 *
 * WHY IT IS NOT components/ui/Modal. That component is a cream card with
 * padding, a rounded border and a lift shadow — the right frame for a form and
 * the wrong one for a photograph. Here the photograph IS the interface: a deep
 * ink ground, the picture, and the two smallest controls that can still be
 * operated. No panel, no toolbar, no zoom percentage, no plus and minus.
 *
 * THE LARGER FILE IS REQUESTED HERE AND ONLY HERE. Nothing in this component
 * renders until somebody opens it, so a visitor who never zooms never asks the
 * optimizer for a zoom-sized variant. The PDP frame and the cards keep the
 * responsive sizes #132 tuned; this asks for the top of that same ladder,
 * capped by the existing 1920 ceiling, and never widens it.
 *
 * ONE GESTURE MODEL. Pointer events cover mouse, pen and touch together, so
 * pinch is two pointers rather than a separate touch-event path, and the same
 * decideCardGesture that drives the cards decides a fitted swipe. All of the
 * arithmetic is in lib/imageZoom.
 */
export default function ImageViewer({
  images,
  alt,
  index,
  onIndexChange,
  onClose,
}: {
  images: string[];
  alt: string;
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [maxZoom, setMaxZoom] = useState(2);
  const [reduced, setReduced] = useState(false);
  const [dragging, setDragging] = useState(false);

  const frameRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Live values the pointer handlers read without re-rendering per move.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef({ x: 0, y: 0, offX: 0, offY: 0, dist: 0, zoom: 1, multi: false });
  const moved = useRef(false);
  const lastTap = useRef(0);

  const hasMany = images.length > 1;
  const atStart = index === 0;
  const atEnd = index === images.length - 1;

  const frame = () =>
    frameRef.current?.getBoundingClientRect() ?? { width: 0, height: 0 };

  const applyPan = useCallback((x: number, y: number, z: number) => {
    const rect = frame();
    setOffset(
      clampPan({ x, y, zoom: z, frameWidth: rect.width, frameHeight: rect.height })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setZoomAround = useCallback(
    (next: number) => {
      const z = clampZoom(next, maxZoom);
      setZoom(z);
      // Re-clamp the existing offset against the new scale, so zooming out
      // never leaves the picture stranded off-centre.
      setOffset((o) => {
        const rect = frame();
        return clampPan({
          x: z <= MIN_ZOOM ? 0 : o.x,
          y: z <= MIN_ZOOM ? 0 : o.y,
          zoom: z,
          frameWidth: rect.width,
          frameHeight: rect.height,
        });
      });
    },
    [maxZoom]
  );

  /** Fitting resets the magnification — a new photograph starts fitted. */
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

  /* ---------------------------------------------------------------- effects */

  useEffect(() => {
    setReduced(
      typeof window !== "undefined" &&
        !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    );
  }, []);

  /*
   * SCROLL LOCK AND FOCUS RESTORATION, in one effect so they cannot get out of
   * step. The element that opened the viewer is captured on mount and focused
   * again on unmount — without it, closing drops focus onto <body> and a
   * keyboard user is returned to the top of the document rather than to the
   * photograph they were looking at.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, []);

  /*
   * FOCUS CANNOT LEAVE, even when something outside takes it.
   *
   * The Tab handler below covers keyboards. This covers everything else — and
   * the case that made it necessary is the ordinary one: a tap opens the viewer,
   * the browser then delivers the deferred synthetic click to the gallery now
   * sitting BEHIND the dialog, and focus lands on <body>. A screen-reader user
   * on a phone would open the viewer and find themselves outside it.
   */
  useEffect(() => {
    // BOTH events, because they describe different escapes. `focusin` catches
    // focus landing on something focusable outside. `focusout` catches focus
    // falling to <body>, which fires no focusin at all — and that is the exact
    // case here, so listening to focusin alone silently does nothing.
    const restore = () => {
      // Deferred: during a legitimate move WITHIN the dialog there is an instant
      // where activeElement is <body>, and reacting to it would fight the user.
      setTimeout(() => {
        const node = dialogRef.current;
        if (node && !node.contains(document.activeElement)) closeRef.current?.focus();
      }, 0);
    };
    const onFocusIn = (e: FocusEvent) => {
      const node = dialogRef.current;
      if (node && !node.contains(e.target as Node)) restore();
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", restore);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", restore);
    };
  }, []);

  /* Escape, arrows, and a Tab that cannot leave the dialog. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
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

  /*
   * Wheel and trackpad pinch. Non-passive, because a viewer that lets the wheel
   * fall through would scroll the page behind it. Registered on the node rather
   * than through React, whose onWheel is passive and cannot preventDefault.
   */
  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoomAround(wheelZoom({ zoom, deltaY: e.deltaY, max: maxZoom }));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [maxZoom, setZoomAround, zoom]);

  /* ---------------------------------------------------------------- pointers */

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;

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
    if (pointers.current.size > 2) {
      start.current.multi = true;
      return;
    }
    start.current = {
      x: e.clientX,
      y: e.clientY,
      offX: offset.x,
      offY: offset.y,
      dist: 0,
      zoom,
      multi: false,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const next = pinchZoom({
        startDistance: start.current.dist,
        currentDistance: pointDistance(a, b),
        startZoom: start.current.zoom,
        max: maxZoom,
      });
      moved.current = true;
      setZoomAround(next);
      return;
    }

    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved.current = true;
    // Only a magnified photograph moves under the finger. Fitted, the drag is
    // being measured for a swipe and the picture stays where it is.
    if (zoom > MIN_ZOOM + 0.01) {
      applyPan(start.current.offX + dx, start.current.offY + dy, zoom);
    }
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const had = pointers.current.has(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) return; // still pinching
    setDragging(false);
    if (!had) return;

    const multi = start.current.multi;
    start.current.multi = false;
    if (multi) return; // a pinch never also navigates

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

    if (decision.kind === "navigate") { go(decision.nextIndex - index); return; }
    if (decision.kind !== "tap" || cancelled) return;

    // A tap: double within 300ms toggles magnification, single does nothing —
    // closing on a stray tap is how a viewer loses somebody mid-inspection.
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      setZoomAround(doubleTapZoom(zoom, maxZoom));
    } else {
      lastTap.current = now;
    }
  };

  /* ------------------------------------------------------------------ render */

  const zoomed = zoom > MIN_ZOOM + 0.01;
  const navClass =
    "tap-44 pointer-events-none absolute top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-white/70 opacity-0 transition-opacity hover:text-white disabled:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} — full screen`}
      className="group fixed inset-0 z-[70] flex flex-col bg-ink"
    >
      {/* The photograph, and nothing framing it. */}
      <div
        ref={frameRef}
        className={cn(
          "relative flex-1 touch-none select-none overflow-hidden",
          zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e)}
        onPointerCancel={(e) => finish(e, true)}
      >
        <div
          className={cn(
            "absolute inset-0",
            // The transition is for the double-tap and the wheel; a drag sets
            // the offset every frame and must not be smoothed, or it lags the
            // finger. Reduced motion removes it entirely.
            !dragging && !reduced && "transition-transform duration-200 ease-out",
            reduced && "transition-none"
          )}
          style={{
            transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
          }}
        >
          <Image
            key={images[index]}
            src={images[index]}
            alt={alt}
            fill
            // The zoom-sized request, made only because this component mounted.
            sizes={viewerSizes()}
            className="object-contain"
            priority
            onLoad={(e) => {
              // How much magnification this particular file can honestly
              // support, measured from the variant that actually arrived.
              const img = e.currentTarget;
              const rect = frame();
              setMaxZoom(
                maxZoomFor({
                  naturalWidth: img.naturalWidth,
                  displayedWidth: containedWidth({
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    frameWidth: rect.width,
                    frameHeight: rect.height,
                  }),
                  dpr: typeof window !== "undefined" ? window.devicePixelRatio : 1,
                })
              );
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
              className={cn(navClass, "left-2 md:left-4")}
            >
              <ChevronLeft className="h-6 w-6" strokeWidth={1.25} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); go(1); }}
              disabled={atEnd}
              aria-label="Next image"
              className={cn(navClass, "right-2 md:right-4")}
            >
              <ChevronRight className="h-6 w-6" strokeWidth={1.25} />
            </button>
          </>
        )}
      </div>

      {/* Close: the one control that is always visible, and it is small. */}
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close image viewer"
        className="tap-44 absolute right-3 top-3 z-30 flex h-10 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 md:right-5 md:top-5"
      >
        <X className="h-5 w-5" strokeWidth={1.25} />
      </button>

      {hasMany && (
        <span
          className="pointer-events-none absolute bottom-5 left-1/2 z-30 -translate-x-1/2 font-body text-xs tabular-nums tracking-widest text-white/55"
          aria-hidden="true"
        >
          {index + 1} / {images.length}
        </span>
      )}

      {/* Position for anyone who cannot see the counter, including after a
          swipe — which has no control for a screen reader to announce. */}
      <p className="sr-only" role="status" aria-live="polite">
        Image {index + 1} of {images.length}
      </p>
    </div>
  );
}

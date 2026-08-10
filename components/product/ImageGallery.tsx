"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Expand } from "lucide-react";
import { cn } from "@/lib/utils";
import Modal from "@/components/ui/Modal";
import ImageWeaveOverlay from "@/components/weave/ImageWeaveOverlay";

/**
 * The gallery.
 *
 * ONE IMAGE PER FRAME, CROSS-FADED. Every photograph is rendered stacked and
 * only the active one is opaque, so changing angle is a 500ms fade rather than a
 * swap that flashes the linen backing while the next file decodes. That costs
 * the whole gallery up front — which is why only the FIRST is `priority` and the
 * rest are lazy: they are in the DOM but a browser fetches them when they matter.
 *
 * TALLER THAN IT WAS. 4:5 is a category-card shape; a product page is where
 * somebody looks closely, so the main frame is 3:4 and rises to the full column
 * on desktop. The lightbox stays for anyone who wants it larger still.
 *
 * ARROWS YOU CAN SEE AND PRESS. The first version of this shipped keyboard
 * arrows only — which is not navigation, it is a secret. Almost nobody tries the
 * arrow keys on a photograph, so the gallery read as "click each thumbnail
 * individually" and the cross-fade looked broken. The buttons are the primary
 * control now; the keys still work for anyone who does reach for them.
 *
 * THEY ARE ALWAYS VISIBLE ON TOUCH and fade in on hover on desktop. A control
 * that only appears on hover does not exist on a phone, and hiding it there
 * would repeat the same mistake in a different way.
 */
export default function ImageGallery({
  images,
  alt,
}: {
  images: string[];
  alt: string;
}) {
  const [active, setActive] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [pointer, setPointer] = useState({ x: 0, y: 0, active: false });

  const go = (dir: number) =>
    setActive((i) => (i + dir + images.length) % images.length);

  // A product can legitimately have no photo yet — render the frame rather
  // than passing undefined to next/image.
  if (images.length === 0) {
    return (
      <div className="flex aspect-[4/5] w-full items-center justify-center rounded-2xl bg-linen text-sm text-ink/40">
        Photography coming soon
      </div>
    );
  }

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
        className="group relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-linen focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-terracotta/40"
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top, active: true });
        }}
        onPointerLeave={() => setPointer((p) => ({ ...p, active: false }))}
      >
        {/* Stacked, not swapped. The active one fades in over the last, so an
            angle change never shows the empty frame underneath. */}
        {images.map((src, i) => (
          <Image
            key={src + i}
            src={src}
            alt={i === active ? alt : ""}
            aria-hidden={i !== active}
            fill
            // Only the cover is priority: it is the page's LCP. The others are
            // lazy — present in the markup, fetched when the browser decides.
            priority={i === 0}
            sizes="(min-width: 1024px) 50vw, 100vw"
            className={`object-cover transition-opacity duration-500 ease-out motion-reduce:transition-none ${
              i === active ? "opacity-100" : "opacity-0"
            }`}
          />
        ))}
        {/* Interactive weave — the cloth reacts to your hand. */}
        <ImageWeaveOverlay pointer={pointer} />
        {images.length > 1 && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); go(-1); }}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink shadow-soft backdrop-blur transition-all duration-300 hover:bg-cream lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); go(1); }}
              aria-label="Next image"
              className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink shadow-soft backdrop-blur transition-all duration-300 hover:bg-cream lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
            >
              <ChevronRight className="h-5 w-5" />
            </button>

            {/* Where you are in the set, for anyone who does not want to count
                thumbnails. Bottom left, so it never sits under the arrows. */}
            <span className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-cream/80 px-3 py-1 text-xs tabular-nums text-ink/70 backdrop-blur">
              {active + 1} / {images.length}
            </span>
          </>
        )}

        <button
          onClick={() => setLightboxOpen(true)}
          aria-label="Open full image"
          className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-cream/80 text-ink opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
        >
          <Expand className="h-4 w-4" />
        </button>
      </div>

      {images.length > 1 && (
        <div className="mt-4 grid grid-cols-4 gap-3">
          {images.map((src, i) => (
            <button
              key={src + i}
              onClick={() => setActive(i)}
              aria-label={`View image ${i + 1} of ${images.length}`}
              aria-current={active === i}
              className={cn(
                "relative aspect-[3/4] overflow-hidden rounded-lg bg-linen transition-all duration-300",
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

      <Modal
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        className="max-w-2xl"
      >
        <div className="relative aspect-[4/5] w-full overflow-hidden rounded-xl bg-linen">
          <Image
            src={images[active]}
            alt={alt}
            fill
            sizes="(min-width: 1024px) 640px, 90vw"
            className="object-cover"
          />
          {images.length > 1 && (
            <>
              <button
                onClick={() => go(-1)}
                aria-label="Previous image"
                className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink backdrop-blur transition-colors hover:bg-cream"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                onClick={() => go(1)}
                aria-label="Next image"
                className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-cream/85 text-ink backdrop-blur transition-colors hover:bg-cream"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

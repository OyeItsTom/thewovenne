"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Expand } from "lucide-react";
import { cn } from "@/lib/utils";
import Modal from "@/components/ui/Modal";
import ImageWeaveOverlay from "@/components/weave/ImageWeaveOverlay";

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

  return (
    <div>
      <div
        className="group relative aspect-[4/5] w-full overflow-hidden rounded-2xl bg-linen"
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top, active: true });
        }}
        onPointerLeave={() => setPointer((p) => ({ ...p, active: false }))}
      >
        <Image
          src={images[active]}
          alt={alt}
          fill
          priority
          sizes="(min-width: 1024px) 50vw, 100vw"
          className="object-cover"
        />
        {/* Interactive weave — the cloth reacts to your hand. */}
        <ImageWeaveOverlay pointer={pointer} />
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
              aria-label={`View image ${i + 1}`}
              className={cn(
                "relative aspect-square overflow-hidden rounded-lg bg-linen ring-2 ring-offset-2 ring-offset-cream transition-all",
                active === i ? "ring-terracotta" : "ring-transparent"
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

"use client";

import { useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import Modal from "@/components/ui/Modal";

export default function ImageGallery({
  images,
  alt,
}: {
  images: string[];
  alt: string;
}) {
  const [active, setActive] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setLightboxOpen(true)}
        aria-label="Open image"
        className="relative block aspect-[4/5] w-full overflow-hidden rounded-2xl bg-linen"
      >
        <Image
          src={images[active]}
          alt={alt}
          fill
          priority
          sizes="(min-width: 1024px) 50vw, 100vw"
          className="object-cover"
        />
      </button>

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
        </div>
      </Modal>
    </div>
  );
}

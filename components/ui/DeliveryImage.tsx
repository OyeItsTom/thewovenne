"use client";

import { useState } from "react";
import Image, { type ImageProps } from "next/image";
import { imageFor, type ImageUse, type ImageVariantMap } from "@/lib/imageVariants";

/**
 * next/image, pointed at the right-sized copy of a product photograph.
 *
 * `src` is ALWAYS the master — the stored URL — and `use` says what the image
 * is for. imageFor() (lib/imageVariants) picks the registered derivative for
 * that use, or the master when there is none, so a photograph without
 * derivatives renders exactly as it did before.
 *
 * NEVER A BROKEN IMAGE. If the derivative fails to load for any reason — an
 * object missing despite its registry row, an optimizer error — the element
 * falls back to the master once, the same frame the customer was looking at.
 * Everything else (sizes, priority, loading, fill, alt, handlers) is passed to
 * next/image untouched, which is what keeps the gallery's eager/lazy rules, the
 * LCP preload and the zoom layer's onLoad measurement working as before.
 */
export default function DeliveryImage({
  src,
  use,
  variants,
  alt,
  onError,
  ...rest
}: Omit<ImageProps, "src"> & {
  src: string;
  use: ImageUse;
  variants?: ImageVariantMap | null;
}) {
  // Keyed to the master, so a different photograph starts over.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const preferred = imageFor(src, use, variants);
  const shown = failedFor === src ? src : preferred;

  return (
    <Image
      // src, then alt, then everything else — the attribute order next/image
      // rendered before, which server-HTML checks compare against.
      src={shown}
      alt={alt}
      {...rest}
      onError={(event) => {
        if (shown !== src) setFailedFor(src);
        onError?.(event);
      }}
    />
  );
}

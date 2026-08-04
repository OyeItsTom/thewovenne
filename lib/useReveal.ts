"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Fade-and-rise a element the first time it scrolls into view.
 *
 * REPLACES framer-motion's `whileInView` on the hot path. That library is
 * ~50 KB and was landing in the shared bundle because components the layout
 * always mounts imported it — so every page paid for it, on a 4× throttled
 * phone, to animate things most visitors scroll straight past.
 *
 * This does the same job with an IntersectionObserver and a CSS transition, in
 * a few hundred bytes. The observer disconnects on first reveal: a product grid
 * holds dozens of cards and none of them needs watching twice.
 *
 * Respects prefers-reduced-motion by reporting "already revealed", so the
 * element simply exists rather than animating.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Anyone who has asked for less motion gets none, and gets it immediately.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setRevealed(true);
      return;
    }

    // No IntersectionObserver — show it rather than leave it invisible. A
    // missing animation is a detail; content stuck at opacity 0 is a bug.
    if (typeof IntersectionObserver === "undefined") {
      setRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      // Matches the -50px margin the framer version used, so cards still begin
      // moving slightly before they reach the fold.
      { rootMargin: "-50px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, revealed };
}

/** The paired classes. Kept here so every reveal looks identical. */
export const revealClass = (revealed: boolean) =>
  `transition-[opacity,transform] duration-500 ease-out ${
    revealed ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
  }`;

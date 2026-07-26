"use client";

import { useEffect, useState } from "react";

export type WeaveTier = "canvas" | "css";

/**
 * Decide whether to run the full canvas weave or the lightweight CSS fallback.
 * Low-power / small devices get the CSS band pattern so we hold 60fps. We detect
 * via viewport width and `navigator.hardwareConcurrency`, and start as "css" so
 * SSR + first paint are never blocked — the canvas upgrade happens post-mount.
 */
export function useWeaveTier(): WeaveTier {
  const [tier, setTier] = useState<WeaveTier>("css");

  useEffect(() => {
    const cores = navigator.hardwareConcurrency ?? 4;
    const wide = window.innerWidth >= 768;
    const capable = cores >= 4 && wide;
    if (capable) setTier("canvas");
  }, []);

  return tier;
}

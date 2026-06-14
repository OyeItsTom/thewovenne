import type { Variants } from "framer-motion";

/** Fade + rise on scroll/entry. Falls back to opacity-only for reduced motion. */
export function fadeUp(reduced: boolean | null): Variants {
  return {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 24 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: reduced ? 0.4 : 0.8, ease: [0.22, 1, 0.36, 1] },
    },
  };
}

/** Stagger children on entry; staggering is dropped for reduced motion. */
export function staggerContainer(reduced: boolean | null, stagger = 0.15): Variants {
  return {
    hidden: {},
    visible: {
      transition: { staggerChildren: reduced ? 0 : stagger },
    },
  };
}

/** Slide in from the right edge (cart drawer). Falls back to a fade. */
export function slideInFromRight(reduced: boolean | null): Variants {
  return {
    hidden: reduced ? { opacity: 0 } : { x: "100%", opacity: 1 },
    visible: {
      x: 0,
      opacity: 1,
      transition: { duration: reduced ? 0.3 : 0.4, ease: [0.22, 1, 0.36, 1] },
    },
    exit: reduced ? { opacity: 0 } : { x: "100%", opacity: 1 },
  };
}

/** Slide in from the left edge (filter drawer). Falls back to a fade. */
export function slideInFromLeft(reduced: boolean | null): Variants {
  return {
    hidden: reduced ? { opacity: 0 } : { x: "-100%", opacity: 1 },
    visible: {
      x: 0,
      opacity: 1,
      transition: { duration: reduced ? 0.3 : 0.4, ease: [0.22, 1, 0.36, 1] },
    },
    exit: reduced ? { opacity: 0 } : { x: "-100%", opacity: 1 },
  };
}

/** Scale in from center (modals). Falls back to a fade. */
export function scaleIn(reduced: boolean | null): Variants {
  return {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: { duration: reduced ? 0.2 : 0.25, ease: [0.22, 1, 0.36, 1] },
    },
    exit: reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95 },
  };
}

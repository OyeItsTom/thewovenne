"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";

/**
 * A section divider that is *woven in real time* as the seam scrolls through the
 * viewport (§0 layer 2). Framer Motion's useScroll → useTransform drives the SVG
 * stroke-dashoffset so the interlacing thread appears to be woven by the scroll.
 * For reduced motion, the seam renders fully drawn and static.
 */
export default function WovenSeam({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "center center"],
  });
  // Full dash length hidden → revealed as the seam enters the viewport.
  const dashoffset = useTransform(scrollYProgress, [0, 1], [1000, 0]);

  return (
    <div
      ref={ref}
      aria-hidden
      className={`container-wovenne py-6 md:py-10 ${className}`}
    >
      <svg
        viewBox="0 0 1000 24"
        preserveAspectRatio="none"
        className="h-6 w-full"
        fill="none"
      >
        {/* Weft base thread */}
        <motion.path
          d="M0 12 Q 25 4 50 12 T 100 12 T 150 12 T 200 12 T 250 12 T 300 12 T 350 12 T 400 12 T 450 12 T 500 12 T 550 12 T 600 12 T 650 12 T 700 12 T 750 12 T 800 12 T 850 12 T 900 12 T 950 12 T 1000 12"
          stroke="#C9A84C"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={1000}
          style={{ strokeDashoffset: reduced ? 0 : dashoffset }}
        />
        {/* Counter thread — over/under interlace */}
        <motion.path
          d="M0 12 Q 25 20 50 12 T 100 12 T 150 12 T 200 12 T 250 12 T 300 12 T 350 12 T 400 12 T 450 12 T 500 12 T 550 12 T 600 12 T 650 12 T 700 12 T 750 12 T 800 12 T 850 12 T 900 12 T 950 12 T 1000 12"
          stroke="#C2714F"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={1000}
          strokeOpacity={0.7}
          style={{ strokeDashoffset: reduced ? 0 : dashoffset }}
        />
      </svg>
    </div>
  );
}

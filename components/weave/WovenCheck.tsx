"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * A checkmark that is *woven* into being: warp + weft threads interlace, a gold
 * ring draws around them, then the check strokes in. Reduced motion shows the
 * finished mark with no animation.
 */
export default function WovenCheck() {
  const reduced = useReducedMotion();

  // With reduced motion, everything is simply drawn (pathLength 1, no transition).
  const draw = (delay: number, duration = 0.6) =>
    reduced
      ? { initial: { pathLength: 1, opacity: 1 }, animate: { pathLength: 1, opacity: 1 } }
      : {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: { delay, duration, ease: [0.22, 1, 0.36, 1] as const },
        };

  const warp = [34, 42, 50, 58, 66];
  const weft = [34, 42, 50, 58, 66];

  return (
    <svg
      viewBox="0 0 100 100"
      className="h-24 w-24"
      role="img"
      aria-label="Order confirmed"
    >
      {/* Weft — horizontal threads */}
      {weft.map((y, i) => (
        <motion.line
          key={`weft-${y}`}
          x1={30}
          y1={y}
          x2={70}
          y2={y}
          stroke="#C9A84C"
          strokeWidth={0.8}
          strokeOpacity={0.5}
          {...draw(reduced ? 0 : i * 0.08, 0.5)}
        />
      ))}
      {/* Warp — vertical threads */}
      {warp.map((x, i) => (
        <motion.line
          key={`warp-${x}`}
          x1={x}
          y1={30}
          x2={x}
          y2={70}
          stroke="#C2714F"
          strokeWidth={0.8}
          strokeOpacity={0.35}
          {...draw(reduced ? 0 : 0.15 + i * 0.08, 0.5)}
        />
      ))}
      {/* Ring */}
      <motion.circle
        cx={50}
        cy={50}
        r={38}
        fill="none"
        stroke="#C9A84C"
        strokeWidth={1.5}
        {...draw(reduced ? 0 : 0.5, 0.8)}
      />
      {/* Checkmark */}
      <motion.path
        d="M34 51 L46 63 L68 39"
        fill="none"
        stroke="#1C1F3B"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...draw(reduced ? 0 : 1.1, 0.6)}
      />
    </svg>
  );
}

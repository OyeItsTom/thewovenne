"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/lib/motion";
import { buttonClassName } from "@/components/ui/Button";

export default function Hero() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced, 0.15);
  const item = fadeUp(reduced);

  return (
    <section className="relative flex min-h-[90vh] items-center justify-center overflow-hidden bg-cream">
      <div
        className="bg-weave absolute inset-0 motion-safe:animate-unfold"
        aria-hidden
      />

      <motion.div
        initial="hidden"
        animate="visible"
        variants={container}
        className="container-wovenne relative z-10 flex flex-col items-center py-24 text-center"
      >
        <motion.h1
          variants={item}
          className="font-heading text-6xl leading-[1.05] tracking-wide text-ink sm:text-7xl md:text-[7rem]"
        >
          THE WOVENNE
        </motion.h1>
        <motion.p
          variants={item}
          className="mt-6 font-body text-base uppercase tracking-[0.3em] text-terracotta sm:text-lg"
        >
          Woven in India. Worn for life.
        </motion.p>
        <motion.p
          variants={item}
          className="mt-6 max-w-xl text-base leading-relaxed text-ink/70 sm:text-lg"
        >
          Authentic, handcrafted linen — sent direct from the loom houses of
          India to your door in the UK. No middleman, no compromise.
        </motion.p>
        <motion.div variants={item} className="mt-10">
          <Link href="/shop" className={buttonClassName("primary", "lg")}>
            Explore the Collection
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}

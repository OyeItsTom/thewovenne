"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/lib/motion";
import { buttonClassName } from "@/components/ui/Button";
import WeaveCanvas from "@/components/weave/WeaveCanvas";
import { useWeaveTier } from "@/components/weave/useWeaveTier";
import { DEFAULT_CONTENT } from "@/lib/content";
import type { HomeHeroContent } from "@/lib/types";

export default function Hero({ content }: { content?: HomeHeroContent }) {
  const c = content ?? DEFAULT_CONTENT.home_hero;
  const reduced = useReducedMotion();
  const tier = useWeaveTier();
  // Content reveals once the weave has settled (or immediately for CSS/reduced).
  const [woven, setWoven] = useState(false);
  const revealed = woven || tier === "css" || !!reduced;

  const container = staggerContainer(reduced, 0.15);
  const item = fadeUp(reduced);

  return (
    <section className="relative flex min-h-[92vh] items-center justify-center overflow-hidden bg-cream">
      {/* The signature weave — full canvas on capable devices, CSS band fallback otherwise. */}
      {tier === "canvas" ? (
        <div className="absolute inset-0">
          <WeaveCanvas onComplete={() => setWoven(true)} />
        </div>
      ) : (
        <div className="weave-fallback absolute inset-0" aria-hidden />
      )}

      {/* Soft vignette so the wordmark reads over the threads. */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-cream/40 via-cream/10 to-cream/70"
        aria-hidden
      />

      <motion.div
        initial="hidden"
        animate={revealed ? "visible" : "hidden"}
        variants={container}
        className="container-wovenne relative z-10 flex flex-col items-center py-24 text-center"
      >
        <motion.p variants={item} className="eyebrow mb-6">
          {c.eyebrow}
        </motion.p>
        <motion.h1
          variants={item}
          className="font-heading text-display-md tracking-luxe text-ink sm:text-display-lg md:text-display-xl"
        >
          {c.heading}
        </motion.h1>
        <motion.p
          variants={item}
          className="mt-8 max-w-prose text-base leading-relaxed text-ink/70 sm:text-lg"
        >
          {c.subheading}
        </motion.p>
        <motion.div variants={item} className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link href={c.cta_href} className={buttonClassName("primary", "lg")}>
            {c.cta_label}
          </Link>
          <Link href="/#story" className={buttonClassName("ghost", "lg")}>
            Our Story
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}

"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/lib/motion";
import { buttonClassName } from "@/components/ui/Button";
import { DEFAULT_CONTENT } from "@/lib/content";
import type { HomeHeroContent } from "@/lib/types";

/**
 * Temporary logo-led hero. The illustrated mark is the centerpiece until the
 * animated brand film is ready, at which point it swaps back out. The weave
 * canvas (components/weave/WeaveCanvas.tsx) is left in the codebase for that.
 */
export default function Hero({ content }: { content?: HomeHeroContent }) {
  const c = content ?? DEFAULT_CONTENT.home_hero;
  const reduced = useReducedMotion();

  const container = staggerContainer(reduced, 0.15);
  const item = fadeUp(reduced);

  return (
    <section className="relative flex min-h-[92vh] items-center justify-center overflow-hidden bg-cream">
      <motion.div
        initial="hidden"
        animate="visible"
        variants={container}
        className="container-wovenne relative z-10 flex flex-col items-center py-24 text-center"
      >
        {/* The editable heading stays in the DOM for SEO and screen readers;
            the logo carries it visually. */}
        <h1 className="sr-only">{c.heading}</h1>

        <motion.p variants={item} className="eyebrow mb-8">
          {c.eyebrow}
        </motion.p>

        <motion.div variants={item}>
          <Image
            src="/logo_illustrated.png"
            alt="THE WOVENNE"
            width={2275}
            height={2275}
            priority
            sizes="(max-width: 640px) 78vw, (max-width: 1024px) 55vw, 520px"
            className="mx-auto h-auto w-[min(78vw,520px)]"
          />
        </motion.div>

        <motion.p
          variants={item}
          className="mt-10 max-w-prose text-base leading-relaxed text-ink/70 sm:text-lg"
        >
          {c.subheading}
        </motion.p>

        <motion.div
          variants={item}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
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

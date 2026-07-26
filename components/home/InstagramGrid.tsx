"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";
import { Instagram } from "lucide-react";
import { fadeUp, staggerContainer } from "@/lib/motion";

const INSTAGRAM_URL = "https://www.instagram.com/thewovenne";
const cells = Array.from({ length: 6 }, (_, i) => i + 1);

export default function InstagramGrid() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced, 0.08);
  const item = fadeUp(reduced);

  return (
    <section className="section-padding container-wovenne">
      <div className="text-center">
        <span className="eyebrow">Follow Along</span>
        <h2 className="mt-3 font-heading text-4xl text-ink sm:text-5xl">
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-terracotta"
          >
            @thewovenne
          </a>
        </h2>
      </div>

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        variants={container}
        className="mt-12 grid grid-cols-3 gap-2 sm:gap-4 md:grid-cols-6"
      >
        {cells.map((i) => (
          <motion.div key={i} variants={item}>
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="THE WOVENNE on Instagram (@thewovenne)"
              className="group relative block aspect-square overflow-hidden rounded-lg bg-linen"
            >
              <Image
                src="https://placehold.co/400x400/F0EAD6/1C1F3B?text=THE+WOVENNE"
                alt="THE WOVENNE on Instagram"
                fill
                sizes="200px"
                className="object-cover transition-transform duration-700 group-hover:scale-110"
              />
              <span className="absolute inset-0 flex items-center justify-center bg-ink/0 text-cream opacity-0 transition-all duration-300 group-hover:bg-ink/40 group-hover:opacity-100">
                <Instagram className="h-6 w-6" />
              </span>
            </a>
          </motion.div>
        ))}
      </motion.div>

      <div className="mt-10 text-center">
        <a
          href={INSTAGRAM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-full border border-ink/15 px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-terracotta hover:text-terracotta"
        >
          <Instagram className="h-5 w-5" /> Follow @thewovenne
        </a>
      </div>
    </section>
  );
}

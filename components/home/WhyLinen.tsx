"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Hand, Heart, Leaf } from "lucide-react";
import { fadeUp, staggerContainer } from "@/lib/motion";
import { DEFAULT_CONTENT } from "@/lib/content";
import type { WhyLinenContent } from "@/lib/types";

const ICONS = [Heart, Leaf, Hand];

export default function WhyLinen({ content }: { content?: WhyLinenContent }) {
  const c = content ?? DEFAULT_CONTENT.why_linen;
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced);
  const item = fadeUp(reduced);

  return (
    <section className="section-padding container-wovenne">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        variants={container}
        className="text-center"
      >
        <motion.span variants={item} className="eyebrow">
          The Wovenne difference
        </motion.span>
        <motion.h2 variants={item} className="mt-3 font-heading text-4xl text-ink sm:text-5xl">
          {c.title}
        </motion.h2>
      </motion.div>

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        variants={container}
        className="mt-14 grid gap-6 sm:grid-cols-3 sm:gap-8"
      >
        {c.cards.map((card, i) => {
          const Icon = ICONS[i % ICONS.length];
          return (
            <motion.div
              key={card.title}
              variants={item}
              className="rounded-2xl bg-linen/60 p-8 text-center"
            >
              <Icon className="mx-auto h-8 w-8 text-terracotta" strokeWidth={1.5} />
              <h3 className="mt-4 font-heading text-xl text-ink">{card.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/70">{card.text}</p>
            </motion.div>
          );
        })}
      </motion.div>
    </section>
  );
}

"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Hand, Heart, Shirt } from "lucide-react";
import { fadeUp, staggerContainer } from "@/lib/motion";
import { DEFAULT_CONTENT } from "@/lib/contentDefaults";
import type { WhyLinenContent } from "@/lib/types";

// In card order: chosen by hand, the cloth itself, worn again. No Leaf — an
// environmental symbol implies a sustainability claim nothing here evidences.
const ICONS = [Hand, Shirt, Heart];

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
        className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8"
      >
        {c.cards.map((card, i) => {
          const Icon = ICONS[i % ICONS.length];
          return (
            <motion.div
              key={card.title}
              variants={item}
              // A hairline over each column rather than a filled panel. Three
              // beige boxes read as a feature grid; a rule and whitespace read
              // as one considered page, the way the product page and footer
              // already separate their parts.
              className="border-t border-ink/10 px-2 pt-8 text-center sm:px-4"
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

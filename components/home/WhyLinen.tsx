"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Hand, Heart, Leaf } from "lucide-react";
import { fadeUp, staggerContainer } from "@/lib/motion";

const points = [
  {
    icon: Heart,
    title: "Body-Friendly",
    copy: "Zero harm to skin — breathable natural fibres that soften with every wash, never synthetic, never itchy.",
  },
  {
    icon: Leaf,
    title: "Naturally Sustainable",
    copy: "Low environmental impact from field to fabric. Linen that returns to the earth, not a landfill.",
  },
  {
    icon: Hand,
    title: "Direct From the Loom",
    copy: "No middleman, no markup games. Every piece is sourced straight from the artisans who weave it.",
  },
];

export default function WhyLinen() {
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
        <motion.span variants={item} className="font-script text-2xl text-terracotta">
          Why Linen
        </motion.span>
        <motion.h2 variants={item} className="mt-2 font-heading text-4xl text-ink sm:text-5xl">
          Cloth That Cares Back
        </motion.h2>
      </motion.div>

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        variants={container}
        className="mt-14 grid gap-6 sm:grid-cols-3 sm:gap-8"
      >
        {points.map(({ icon: Icon, title, copy }) => (
          <motion.div
            key={title}
            variants={item}
            className="rounded-2xl bg-linen/60 p-8 text-center"
          >
            <Icon className="mx-auto h-8 w-8 text-terracotta" strokeWidth={1.5} />
            <h3 className="mt-4 font-heading text-xl text-ink">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink/70">{copy}</p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

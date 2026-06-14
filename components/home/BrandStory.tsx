"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/lib/motion";

export default function BrandStory() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced);
  const item = fadeUp(reduced);

  return (
    <section
      id="story"
      className="section-padding container-wovenne grid items-center gap-12 md:grid-cols-2"
    >
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        variants={item}
        className="relative aspect-[4/5] overflow-hidden rounded-2xl bg-linen order-2 md:order-1"
      >
        <Image
          src="https://placehold.co/800x1000/F0EAD6/1C1F3B?text=THE+WOVENNE"
          alt="An artisan weaving linen on a traditional handloom in India"
          fill
          sizes="(min-width: 768px) 50vw, 100vw"
          className="object-cover"
        />
      </motion.div>

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        variants={container}
        className="order-1 md:order-2"
      >
        <motion.span variants={item} className="font-script text-2xl text-terracotta">
          Our Story
        </motion.span>
        <motion.h2 variants={item} className="mt-2 font-heading text-4xl text-ink sm:text-5xl">
          From Loom House to Front Door
        </motion.h2>
        <motion.p variants={item} className="mt-6 text-base leading-relaxed text-ink/70">
          THE WOVENNE began with a simple frustration: the best Indian linen
          never seemed to leave India. We work directly with handloom weavers
          across Tamil Nadu and Varanasi, paying fair prices and shipping the
          same fabric worn at home — straight to your door in the UK.
        </motion.p>
        <motion.blockquote
          variants={item}
          className="mt-8 border-l-2 border-gold pl-6 font-script text-2xl leading-snug text-ink"
        >
          &ldquo;Original Indian cloth, for people who can tell the
          difference.&rdquo;
        </motion.blockquote>
      </motion.div>
    </section>
  );
}

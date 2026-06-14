"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/lib/motion";

const cells = Array.from({ length: 6 }, (_, i) => i + 1);

export default function InstagramGrid() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced, 0.08);
  const item = fadeUp(reduced);

  return (
    <section className="section-padding container-wovenne">
      <div className="text-center">
        <span className="font-script text-2xl text-terracotta">Follow Along</span>
        <h2 className="mt-2 font-heading text-4xl text-ink sm:text-5xl">
          @thewovenne
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
            <Link
              href="/journal"
              className="group relative block aspect-square overflow-hidden rounded-lg bg-linen"
            >
              <Image
                src="https://placehold.co/400x400/F0EAD6/1C1F3B?text=THE+WOVENNE"
                alt="THE WOVENNE on Instagram"
                fill
                sizes="200px"
                className="object-cover transition-transform duration-700 group-hover:scale-110"
              />
            </Link>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

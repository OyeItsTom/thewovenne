"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { BookOpen } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { fadeUp, staggerContainer } from "@/lib/motion";

export default function JournalPage() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced);
  const item = fadeUp(reduced);

  return (
    <div className="bg-weave">
      <div className="container-wovenne section-padding flex min-h-[60vh] flex-col items-center justify-center text-center">
        <motion.div
          initial="hidden"
          animate="visible"
          variants={container}
          className="flex flex-col items-center"
        >
          <motion.div
            variants={item}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-terracotta/10"
          >
            <BookOpen className="h-7 w-7 text-terracotta" strokeWidth={1.5} />
          </motion.div>

          <motion.span
            variants={item}
            className="mt-6 font-script text-2xl text-terracotta"
          >
            From the Loom
          </motion.span>
          <motion.h1
            variants={item}
            className="mt-2 font-heading text-4xl text-ink sm:text-5xl"
          >
            The Journal
          </motion.h1>
          <motion.p
            variants={item}
            className="mt-4 max-w-md text-base leading-relaxed text-ink/70"
          >
            Stories from our weavers, care guides, and notes on the journey
            from the loom in India to your door in the UK — coming soon.
          </motion.p>
          <motion.div variants={item} className="mt-8">
            <Link href="/shop" className={buttonClassName("primary", "lg")}>
              Explore the Collection
            </Link>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

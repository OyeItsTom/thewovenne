"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { XCircle } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { fadeUp, staggerContainer } from "@/lib/motion";

export default function CheckoutCancelPage() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced);
  const item = fadeUp(reduced);

  return (
    <div className="container-wovenne section-padding flex min-h-[60vh] flex-col items-center justify-center text-center">
      <motion.div
        initial="hidden"
        animate="visible"
        variants={container}
        className="flex flex-col items-center"
      >
        <motion.div
          variants={item}
          className="flex h-20 w-20 items-center justify-center rounded-full bg-linen"
        >
          <XCircle className="h-10 w-10 text-ink/40" strokeWidth={1.5} />
        </motion.div>

        <motion.h1
          variants={item}
          className="mt-6 font-heading text-4xl text-ink sm:text-5xl"
        >
          Checkout Cancelled
        </motion.h1>
        <motion.p
          variants={item}
          className="mt-4 max-w-md text-base leading-relaxed text-ink/70"
        >
          No payment was taken. Your bag is just as you left it, whenever
          you&rsquo;re ready to continue.
        </motion.p>
        <motion.div variants={item} className="mt-8">
          <Link href="/cart" className={buttonClassName("primary", "lg")}>
            Return to Cart
          </Link>
        </motion.div>
      </motion.div>
    </div>
  );
}

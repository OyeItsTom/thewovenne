"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Check, MessageCircle } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { fadeUp, staggerContainer } from "@/lib/motion";

export default function CheckoutSuccessPage() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced);
  const item = fadeUp(reduced);

  const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
  const message = encodeURIComponent(
    "Hi, I've just placed an order with THE WOVENNE and would like to follow up."
  );
  const waHref = `https://wa.me/${number}?text=${message}`;

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
          className="flex h-20 w-20 items-center justify-center rounded-full bg-terracotta/10"
        >
          <motion.div
            initial={reduced ? { opacity: 0 } : { scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
              delay: reduced ? 0 : 0.3,
              duration: reduced ? 0.3 : 0.5,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <Check className="h-10 w-10 text-terracotta" strokeWidth={2.5} />
          </motion.div>
        </motion.div>

        <motion.h1
          variants={item}
          className="mt-6 font-heading text-4xl text-ink sm:text-5xl"
        >
          Thank You
        </motion.h1>
        <motion.p
          variants={item}
          className="mt-4 max-w-md text-base leading-relaxed text-ink/70"
        >
          Your order has been received. A confirmation will be on its way
          shortly — and your linen is one step closer to its journey from the
          loom to your door.
        </motion.p>
        <motion.div
          variants={item}
          className="mt-8 flex flex-col gap-3 sm:flex-row"
        >
          <Link href="/shop" className={buttonClassName("outline", "lg")}>
            Continue Shopping
          </Link>
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClassName("primary", "lg")}
          >
            <MessageCircle className="h-5 w-5" /> Follow Up on WhatsApp
          </a>
        </motion.div>
      </motion.div>
    </div>
  );
}

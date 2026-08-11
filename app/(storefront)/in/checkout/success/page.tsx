"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { MessageCircle } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { fadeUp, staggerContainer } from "@/lib/motion";
import WovenCheck from "@/components/weave/WovenCheck";
import { whatsappHref } from "@/lib/whatsapp";

export default function CheckoutSuccessPage() {
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced);
  const item = fadeUp(reduced);

  const waHref = whatsappHref(
    "Hi, I've just placed an order with THE WOVENNE and would like to follow up."
  );

  return (
    <div className="container-wovenne section-padding flex min-h-[60vh] flex-col items-center justify-center text-center">
      <motion.div
        initial="hidden"
        animate="visible"
        variants={container}
        className="flex flex-col items-center"
      >
        {/* Full lockup — clean reproduction for a confirmation record. Sized by
            width, not height: the asset is a square containing the wordmark and
            contact line, so a small height renders them illegible. Its white
            background is opaque, which is invisible on the white page. */}
        <motion.div variants={item}>
          <Image
            src="/logo_solid_black.png"
            alt="THE WOVENNE"
            width={2275}
            height={2275}
            priority
            sizes="(max-width: 640px) 70vw, 240px"
            className="h-auto w-[min(70vw,240px)]"
          />
        </motion.div>

        <motion.div variants={item} className="mt-4">
          <WovenCheck />
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
          <Link href="/in/shop" className={buttonClassName("outline", "lg")}>
            Continue Shopping
          </Link>
          {waHref && (
            <a
              href={waHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassName("primary", "lg")}
            >
              <MessageCircle className="h-5 w-5" /> Follow Up on WhatsApp
            </a>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}

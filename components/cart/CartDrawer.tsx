"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ShoppingBag, X } from "lucide-react";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import { buttonClassName } from "@/components/ui/Button";
import { slideInFromRight } from "@/lib/motion";
import CartItem from "./CartItem";

export default function CartDrawer() {
  const isOpen = useCartStore((s) => s.isOpen);
  const closeCart = useCartStore((s) => s.closeCart);
  const items = useCartStore((s) => s.items);
  const subtotal = useCartStore((s) => s.subtotal());
  const reduced = useReducedMotion();
  const panel = slideInFromRight(reduced);

  return (
    <AnimatePresence>
      {isOpen && (
        /* Keyed so AnimatePresence can resolve the exit and actually unmount.
           Without it the overlay survives at opacity 0 with pointer-events auto
           and silently blocks every page — see components/ui/Modal.tsx for the
           full account. */
        <div key="cart-drawer" className="fixed inset-0 z-[70] flex justify-end">
          <motion.div
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeCart}
            aria-hidden
          />
          <motion.div
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={panel}
            className="relative flex h-full w-full max-w-md flex-col bg-cream p-6 shadow-lift sm:p-8"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-heading text-2xl text-ink">Your Bag</h2>
              <button
                onClick={closeCart}
                aria-label="Close cart"
                className="text-ink/50 transition-colors hover:text-ink"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {items.length === 0 ? (
              <div className="mt-16 flex flex-1 flex-col items-center justify-center text-center text-ink/50">
                <ShoppingBag className="mb-4 h-10 w-10" strokeWidth={1.5} />
                <p className="text-sm">Your bag is empty.</p>
              </div>
            ) : (
              <div className="mt-6 flex-1 divide-y divide-ink/10 overflow-y-auto">
                {items.map((item) => (
                  <CartItem key={`${item.id}-${item.size}`} item={item} />
                ))}
              </div>
            )}

            {items.length > 0 && (
              <div className="mt-6 space-y-4 border-t border-ink/10 pt-6">
                <div className="flex items-center justify-between font-heading text-lg text-ink">
                  <span>Subtotal</span>
                  <span>{formatINR(subtotal)}</span>
                </div>
                <Link
                  href="/in/cart"
                  onClick={closeCart}
                  className={buttonClassName("primary", "lg", "w-full")}
                >
                  View Cart & Checkout
                </Link>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

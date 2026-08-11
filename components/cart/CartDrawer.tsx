"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ShoppingBag, X } from "lucide-react";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import { buttonClassName } from "@/components/ui/Button";
import { slideInFromRight } from "@/lib/motion";
import CartItem from "./CartItem";

/**
 * Anything that can be focused. Used to work out where the Tab key may go while
 * the drawer is open — the list is walked fresh on every keypress rather than
 * cached, because the cart's contents change underneath it as lines are removed.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function CartDrawer() {
  const isOpen = useCartStore((s) => s.isOpen);
  const closeCart = useCartStore((s) => s.closeCart);
  const items = useCartStore((s) => s.items);
  const subtotal = useCartStore((s) => s.subtotal());
  const reduced = useReducedMotion();
  const panel = slideInFromRight(reduced);

  const panelRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the drawer opened, so it can be handed back. */
  const openerRef = useRef<HTMLElement | null>(null);

  /**
   * What makes this a dialog rather than a div that happens to be on top.
   *
   * MEASURED BEFORE WRITING ANY OF THIS, on a real 390px layout with the drawer
   * genuinely open: no role, no accessible name, focus never left the body, and
   * THIRTY-NINE focusable elements were still reachable behind it. Tab walked
   * straight out of the cart and off into the page underneath, where the
   * customer could not see what was selected.
   *
   * Four things, all of which a dialog is expected to do:
   *
   *   FOCUS GOES IN. The panel takes focus itself rather than the close button,
   *   so a screen reader announces the dialog and its name instead of starting
   *   the customer on "Close".
   *
   *   TAB STAYS IN. Wrapped at both ends, recomputed per keypress.
   *
   *   ESCAPE CLOSES IT. Keyboard-only customers had no way out that did not
   *   involve finding the close button by tabbing.
   *
   *   THE PAGE STOPS SCROLLING. Without this, a swipe over the drawer scrolls
   *   what is behind it, which reads as the drawer sliding away.
   *
   * NO LIBRARY. This is thirty lines against a component that already exists,
   * and a focus-trap dependency would be a larger surface than the problem.
   *
   * DECLARED ABOVE THE `isOpen` EARLY RETURN, and it has to be: a hook cannot
   * sit after a conditional return. It guards on `isOpen` itself instead.
   */
  useEffect(() => {
    if (!isOpen) return;

    openerRef.current = (document.activeElement as HTMLElement) ?? null;

    // Restored rather than cleared: something else may already have wanted the
    // body locked, and assuming "" would quietly undo it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCart();
        return;
      }
      if (event.key !== "Tab") return;

      const node = panelRef.current;
      if (!node) return;

      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);

      // An empty bag has no controls but the close button; if even that is gone,
      // hold focus on the panel rather than letting Tab escape.
      if (focusable.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Back where they were. Landing at the top of the document after closing a
      // drawer is the classic way to lose a keyboard user's place.
      openerRef.current?.focus?.();
    };
  }, [isOpen, closeCart]);

  /*
   * NO AnimatePresence HERE, DELIBERATELY — see #121.
   *
   * It did not unmount this subtree. Closing left the wrapper and its backdrop
   * in the DOM at opacity 0 with pointer-events auto: an invisible sheet over
   * the whole viewport, after which nothing on the page responded. React
   * unmounts synchronously and cannot half-happen. The cost is the slide-out;
   * the entry animation is unchanged.
   *
   * This early return is also what makes the effect above correct on close. The
   * component stops rendering the moment `isOpen` flips, so the cleanup runs
   * straight away and hands focus and body scroll back, rather than waiting on
   * an animation that may never report having finished.
   */
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      <motion.div
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        onClick={closeCart}
        aria-hidden
      />
      <motion.div
        ref={panelRef}
        initial="hidden"
        animate="visible"
        variants={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-drawer-title"
        // Focusable only programmatically: the panel is where focus lands on
        // open, but it should never be a Tab stop of its own afterwards.
        tabIndex={-1}
        // The safe-area inset is added to the existing padding rather than
        // replacing it. It resolves to 0px today because the viewport meta has
        // no viewport-fit=cover, so iOS already keeps content clear of the home
        // indicator — this is here so that adding viewport-fit later cannot
        // silently push the checkout button underneath it.
        className="relative flex h-full w-full max-w-md flex-col bg-cream p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-lift outline-none sm:p-8 sm:pb-[calc(2rem+env(safe-area-inset-bottom))]"
      >
        <div className="flex items-center justify-between">
          <h2 id="cart-drawer-title" className="font-heading text-2xl text-ink">
            Your Bag
          </h2>
          <button
            onClick={closeCart}
            aria-label="Close cart"
            className="tap-44 relative -mr-2 p-2 text-ink/50 transition-colors hover:text-ink"
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
          // overscroll-contain stops the scroll chaining on: without it, flicking
          // past the last line hands the momentum to the page behind, and the
          // drawer appears to drift.
          <div className="mt-6 flex-1 divide-y divide-ink/10 overflow-y-auto overscroll-contain">
            {items.map((item) => (
              <CartItem key={`${item.id}-${item.size}`} item={item} />
            ))}
          </div>
        )}

        {items.length > 0 && (
          // shrink-0 so a long cart cannot squeeze the total and the checkout
          // button out of the panel — the list above scrolls, this stays put.
          <div className="mt-6 shrink-0 space-y-4 border-t border-ink/10 pt-6">
            <div className="flex items-center justify-between font-heading text-lg text-ink">
              <span>Subtotal</span>
              <span>{formatINR(subtotal)}</span>
            </div>
            <Link
              href="/in/cart"
              onClick={closeCart}
              className={buttonClassName("primary", "lg", "w-full")}
            >
              View Cart &amp; Checkout
            </Link>
          </div>
        )}
      </motion.div>
    </div>
  );
}

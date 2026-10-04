"use client";

import { ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { scaleIn } from "@/lib/motion";
import { focusableWithin, nextTrapTarget } from "@/lib/focusTrap";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

/**
 * The shared dialog: Add/Edit Product in the admin, Share Your Style on the
 * account pages.
 *
 * BEFORE THIS: Add Product opened with focus still on the button behind it, and
 * Tab walked straight on into the products table underneath. A keyboard user
 * was moving through controls they could not see, and a screen reader was
 * never told a dialog had opened (it had no accessible name either).
 *
 * What it does now, which is what a modal dialog is expected to do:
 *
 *   FOCUS GOES IN. The panel takes focus itself, as the cart drawer does, so
 *   the dialog is announced by its title rather than starting on "Close".
 *
 *   THE PAGE BEHIND IS INERT. The dialog is portalled to <body> so that every
 *   other child of <body> can be marked `inert` — unreachable by Tab, by click
 *   and by a screen reader's virtual cursor, which a keydown trap alone cannot
 *   stop. Only elements this dialog marked are unmarked on close, so a dialog
 *   opened from inside another does not undo its parent's.
 *
 *   TAB STAYS IN. Wrapped at both ends, recomputed per keypress, because the
 *   product form grows and shrinks (discount fields, sub-categories) while open.
 *   Belt and braces with `inert`: it also covers a browser without it.
 *
 *   ESCAPE CLOSES, AND FOCUS GOES HOME. Back to the control that opened it, so
 *   closing does not drop a keyboard user at the top of the document.
 *
 * Save and publish behaviour belongs to the caller and is untouched.
 */
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  className,
}: ModalProps) {
  const reduced = useReducedMotion();
  const panel = scaleIn(reduced);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Held in a ref so a parent passing a fresh arrow function every render does
  // not tear down and rebuild the trap — and yank focus back to the panel — on
  // every keystroke in the form.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    const opener = document.activeElement as HTMLElement | null;

    // Restored rather than cleared, as in the cart drawer: something else may
    // already have wanted the body locked.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const root = rootRef.current;
    const madeInert: Element[] = [];
    if (root) {
      for (const sibling of Array.from(document.body.children)) {
        if (sibling === root || sibling.hasAttribute("inert")) continue;
        if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
        sibling.setAttribute("inert", "");
        madeInert.push(sibling);
      }
    }

    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const node = panelRef.current;
      if (!node) return;
      const target = nextTrapTarget(
        focusableWithin(node),
        document.activeElement,
        node,
        event.shiftKey
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const el of madeInert) el.removeAttribute("inert");
      // Only if it is still on the page: a save can re-render the table and
      // replace the Edit button that opened us.
      if (opener && opener.isConnected) opener.focus?.();
    };
  }, [isOpen]);

  /*
   * NO AnimatePresence — see components/cart/CartDrawer.tsx for the full
   * account. In short: it did not unmount this subtree on close, leaving an
   * invisible backdrop over the page that swallowed every click. Three attempts
   * to fix it through framer-motion failed on a live preview, so the unmount is
   * React's again. The cost is the exit animation.
   */
  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div ref={rootRef} className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div
            className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            // Focusable only programmatically: where focus lands on open, never
            // a Tab stop of its own afterwards.
            tabIndex={-1}
            className={cn(
              "relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-cream p-6 shadow-lift outline-none sm:p-8",
              className
            )}
            initial="hidden"
            animate="visible"
            variants={panel}
          >
            <button
              type="button"
              onClick={onClose}
              className="absolute right-4 top-4 text-ink/50 transition-colors hover:text-ink"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            {title && (
              <h2 id={titleId} className="mb-6 font-heading text-2xl text-ink">
                {title}
              </h2>
            )}
            {children}
      </motion.div>
    </div>,
    document.body
  );
}

"use client";

import { ReactNode, useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { scaleIn } from "@/lib/motion";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  className,
}: ModalProps) {
  const reduced = useReducedMotion();
  const panel = scaleIn(reduced);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        /*
          CLOSING THIS USED TO BREAK THE WHOLE PAGE.

          AnimatePresence does not unmount this subtree when isOpen goes false.
          Both children reach their exit states — the backdrop fades to opacity 0
          and the panel animates away, so it LOOKS shut — but the wrapper and the
          backdrop stay in the DOM, inset 0, still accepting pointer events. An
          invisible sheet over the viewport. Every link and button underneath
          stops responding, including the control that would reopen it, and the
          only way out is a reload.

          Verified on production with a real mouse: after closing, a click on the
          main navigation did nothing.

          THE FIX DOES NOT ARGUE WITH FRAMER-MOTION. Adding a key — which
          AnimatePresence does want — was tried first and did not help; the
          subtree still lingered. So rather than depending on an unmount that
          demonstrably does not happen, the lingering subtree is made harmless:
          the wrapper never takes pointer events, only the backdrop and the panel
          do, and the backdrop gives them up as part of its exit. Whether or not
          the node is ever removed, nothing is left covering the page.

          The key stays because it is correct, not because it fixed this.

          Same defect and same fix in CartDrawer and FilterSidebar.
        */
        <div key="modal" className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div
            className="pointer-events-auto absolute inset-0 bg-ink/50 backdrop-blur-sm"
            initial={{ opacity: 0, pointerEvents: "auto" }}
            animate={{ opacity: 1, pointerEvents: "auto" }}
            exit={{ opacity: 0, pointerEvents: "none" }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            className={cn(
              "pointer-events-auto relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-cream p-6 shadow-lift sm:p-8",
              className
            )}
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={panel}
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 text-ink/50 transition-colors hover:text-ink"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            {title && (
              <h2 className="mb-6 font-heading text-2xl text-ink">{title}</h2>
            )}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

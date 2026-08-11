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
          THE KEY IS WHAT MAKES THIS CLOSE. AnimatePresence identifies its direct
          children by key. Without one it cannot resolve the exit, so it never
          unmounts the subtree — the inner panel finishes its own exit animation
          and disappears, which makes the modal LOOK closed, while this wrapper
          and its overlay stay behind at opacity 0 with pointer-events auto.

          The result is an invisible sheet across the whole viewport. Every link
          and button under it stops responding, including the control that would
          open the thing again. Verified on production with a real mouse before
          this fix: after closing, a click on the main navigation did nothing.

          Same one-line defect in CartDrawer and FilterSidebar, fixed here too.
        */
        <div key="modal" className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div
            className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            className={cn(
              "relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-cream p-6 shadow-lift sm:p-8",
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

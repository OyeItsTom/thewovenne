"use client";

import { ReactNode, useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
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

  /*
   * NO AnimatePresence — see components/cart/CartDrawer.tsx for the full
   * account. In short: it did not unmount this subtree on close, leaving an
   * invisible backdrop over the page that swallowed every click. Three attempts
   * to fix it through framer-motion failed on a live preview, so the unmount is
   * React's again. The cost is the exit animation.
   */
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div
            className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
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
  );
}

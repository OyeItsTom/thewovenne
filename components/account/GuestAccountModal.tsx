"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Heart, PackageSearch, X, Zap } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";

/**
 * The choice a guest meets when they tap the account icon.
 *
 * IT OPENS ON THAT TAP AND NOWHERE ELSE. An interstitial that greets everyone
 * on arrival is an obstacle between a shopper and the shop; this one only
 * appears when someone has actually reached for their account, which is the
 * one moment the question is relevant.
 *
 * "Continue as guest" is listed first and is a real option, the same as at the
 * checkout. Nothing here is a gate.
 */
export default function GuestAccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes it, and focus moves inside when it opens — a dialog you can
  // only leave with a mouse is a trap for anyone using a keyboard.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    // The page behind must not scroll under the panel on a phone.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-account-title"
      className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center"
    >
      {/* Clicking away closes it. A modal that can only be dismissed by finding
          the right button is the kind people learn to dread. */}
      <button
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-[2px]"
      />

      <div
        ref={panelRef}
        className="relative w-full max-w-md rounded-t-2xl bg-cream p-6 shadow-soft sm:rounded-2xl sm:p-8"
      >
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-full p-1.5 text-ink/40 transition-colors hover:bg-linen hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>

        <h2
          id="guest-account-title"
          className="font-heading text-2xl text-ink sm:text-3xl"
        >
          Your account
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink/60">
          Create an account to track your orders, save items to your wishlist,
          and check out faster next time.
        </p>

        <ul className="mt-5 space-y-2.5 text-sm text-ink/60">
          <li className="flex items-start gap-2.5">
            <PackageSearch aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
            Follow every order from payment to doorstep
          </li>
          <li className="flex items-start gap-2.5">
            <Heart aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
            Keep a wishlist of the pieces you&apos;re considering
          </li>
          <li className="flex items-start gap-2.5">
            <Zap aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
            Your address and phone ready next time
          </li>
        </ul>

        <div className="mt-7 space-y-3">
          <Link
            href="/signup"
            onClick={onClose}
            className={buttonClassName("primary", "lg", "w-full")}
          >
            Create account
          </Link>
          <Link
            href="/login"
            onClick={onClose}
            className={buttonClassName("secondary", "lg", "w-full")}
          >
            Sign in
          </Link>
          <button
            onClick={onClose}
            className="w-full py-2 text-center text-xs uppercase tracking-widest text-ink/50 transition-colors hover:text-ink"
          >
            Continue as guest
          </button>
        </div>

        <p className="mt-5 text-center text-xs text-ink/40">
          You can buy without an account.
        </p>
      </div>
    </div>
  );
}

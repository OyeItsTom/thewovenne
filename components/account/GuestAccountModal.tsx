"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Heart, PackageSearch, Truck, X } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";

/**
 * The choice a guest meets when they tap the account icon.
 *
 * RENDERED THROUGH A PORTAL, AND IT HAS TO BE. The account icon lives in the
 * <header>, which is `backdrop-blur-md` — and an element with a backdrop-filter
 * becomes the containing block for any `position: fixed` descendant. So a modal
 * rendered in place resolved `inset-0` against the 76px-tall nav instead of the
 * viewport: it drew itself inside the header, spilled its content across the
 * bar, and read as a broken page rather than an overlay. Nothing was wrong with
 * the styles — the modal was trapped in the wrong box.
 *
 * Portalling to document.body escapes that containing block entirely.
 *
 * IT OPENS ON THAT TAP AND NOWHERE ELSE. An interstitial that greets everyone
 * on arrival is an obstacle between a shopper and the shop; this appears only
 * when someone has reached for their account, which is the one moment the
 * question is relevant. "Continue as guest" is a real option, not a dismissal.
 */
export default function GuestAccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Portals cannot run during SSR — document does not exist there.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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

  if (!open || !mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-account-title"
      // z-[100] clears the nav (z-40) and the cart drawer (z-50) with room to
      // spare. p-4 keeps the panel off the edges on small screens.
      // font-body sets DM Sans for everything inside; the heading opts back
      // into Cormorant. Outside the app's own layout tree, nothing is
      // inherited — so the fonts are stated here rather than assumed.
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 font-body"
    >
      {/* Clicking away closes it. A modal dismissible only by finding the right
          button is the kind people learn to dread. */}
      <button
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/50 backdrop-blur-[3px]"
      />

      <div
        className="relative w-full max-w-[26rem] overflow-y-auto rounded-2xl border border-ink/10 bg-cream shadow-[0_24px_60px_-12px_rgba(28,31,59,0.28)]"
        // Never taller than the screen. Without this the panel silently clips
        // its own top on a short laptop window — a quieter version of the
        // failure that made this look broken in the first place.
        style={{ maxHeight: "calc(100dvh - 2rem)" }}
      >
        <div className="p-7 sm:p-9">
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-full p-2 text-ink/40 transition-colors hover:bg-linen hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>

          <p className="text-[11px] uppercase tracking-[0.28em] text-terracotta">
            The Wovenne
          </p>
          <h2
            id="guest-account-title"
            className="mt-3 font-heading text-[1.75rem] leading-tight text-ink sm:text-3xl"
          >
            Your account
          </h2>
          <p className="mt-2.5 text-sm leading-relaxed text-ink/60">
            Create an account to track your orders, save the pieces you like,
            and check out faster next time.
          </p>

          <span aria-hidden className="mt-6 block h-px w-10 bg-gold/50" />

          <ul className="mt-6 space-y-3.5 text-sm text-ink/70">
            <li className="flex items-start gap-3">
              <PackageSearch aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
              Follow every order from payment to doorstep
            </li>
            <li className="flex items-start gap-3">
              <Heart aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
              Keep a wishlist of the pieces you&apos;re considering
            </li>
            <li className="flex items-start gap-3">
              <Truck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
              Save your address for faster checkout next time
            </li>
          </ul>

          <div className="mt-8 space-y-3">
            <Link
              href="/in/signup"
              onClick={onClose}
              className={buttonClassName("primary", "lg", "w-full")}
            >
              Create account
            </Link>
            <Link
              href="/in/login"
              onClick={onClose}
              className={buttonClassName("secondary", "lg", "w-full")}
            >
              Sign in
            </Link>
          </div>

          {/* Deliberately quieter than the two above, but a full-width control
              with the same hit area — it is a real choice, not fine print. */}
          <button
            onClick={onClose}
            className="mt-5 w-full rounded-full border border-transparent py-2.5 text-xs uppercase tracking-[0.18em] text-ink/55 transition-colors hover:border-ink/15 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
          >
            Continue as guest
          </button>

          <p className="mt-4 text-center text-xs text-ink/40">
            You can buy without an account.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}

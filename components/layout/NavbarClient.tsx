"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Heart, Menu, ShoppingBag, User, X } from "lucide-react";
import { useCartStore } from "@/lib/store";

export interface NavItem {
  href: string;
  label: string;
}

// Customer account + wishlist routes are built in Phase 4 §3. Until then these
// links resolve to 404s.
const ACCOUNT_HREF = "/login";
const WISHLIST_HREF = "/account/wishlist";

export default function NavbarClient({ navLinks }: { navLinks: NavItem[] }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const totalItems = useCartStore((s) => s.totalItems());
  const toggleCart = useCartStore((s) => s.toggleCart);

  return (
    <header className="sticky top-0 z-40 border-b border-ink/5 bg-cream/90 backdrop-blur-md">
      <nav className="container-wovenne flex items-center justify-between py-4">
        {/* The logo + wordmark is the home button, on every page. */}
        <Link
          href="/"
          aria-label="THE WOVENNE — home"
          className="flex items-center gap-2 font-heading text-2xl tracking-wide text-ink sm:text-3xl"
        >
          <Image
            src="/logo_emblem_transparent.png"
            alt=""
            width={3096}
            height={2792}
            priority
            sizes="40px"
            className="h-8 w-auto"
          />
          THE WOVENNE
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="font-body text-sm uppercase tracking-widest text-ink/80 transition-colors hover:text-terracotta"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-5">
          <Link
            href={WISHLIST_HREF}
            aria-label="Wishlist"
            className="text-ink transition-colors hover:text-terracotta"
          >
            <Heart className="h-6 w-6" strokeWidth={1.5} />
          </Link>

          <Link
            href={ACCOUNT_HREF}
            aria-label="Login or sign up"
            className="text-ink transition-colors hover:text-terracotta"
          >
            <User className="h-6 w-6" strokeWidth={1.5} />
          </Link>

          <button
            onClick={toggleCart}
            aria-label="Open cart"
            className="relative text-ink transition-colors hover:text-terracotta"
          >
            <ShoppingBag className="h-6 w-6" />
            {totalItems > 0 && (
              <span className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-terracotta text-[10px] font-semibold text-cream">
                {totalItems}
              </span>
            )}
          </button>

          <button
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle menu"
            className="text-ink md:hidden"
          >
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-ink/5 md:hidden"
          >
            <div className="container-wovenne flex flex-col gap-4 py-4">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className="font-body text-sm uppercase tracking-widest text-ink/80"
                >
                  {link.label}
                </Link>
              ))}
              <Link
                href={ACCOUNT_HREF}
                onClick={() => setMobileOpen(false)}
                className="font-body text-sm uppercase tracking-widest text-ink/80"
              >
                Login / Sign Up
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

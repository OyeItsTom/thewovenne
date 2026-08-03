"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Heart, Menu, Search, ShoppingBag, User, X } from "lucide-react";
import { useCartStore } from "@/lib/store";
import SearchField from "@/components/shop/SearchField";

export interface NavChild {
  href: string;
  label: string;
}

export interface NavItem {
  href: string;
  label: string;
  /** Sub-categories. Absent or empty for links that aren't sections. */
  children?: NavChild[];
}

// The account area, not the login page. This used to point at /login
// unconditionally, so a signed-in customer clicking the person icon was sent
// back to log in — which looked like a broken session and was really a hardcoded
// link. Middleware sends guests from here to /login?from=, so one href serves
// both states without the nav needing to know who is signed in.
const ACCOUNT_HREF = "/account/profile";
const WISHLIST_HREF = "/account/wishlist";

/**
 * Long enough to cross the gap between the trigger and the panel, short enough
 * that the menu never feels like it is lingering. Without it the menu closes
 * the instant the pointer leaves the word and the panel is unreachable — the
 * classic hover-menu bug.
 */
const CLOSE_DELAY_MS = 140;

export default function NavbarClient({ navLinks }: { navLinks: NavItem[] }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [expandedMobile, setExpandedMobile] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useReducedMotion();
  const totalItems = useCartStore((s) => s.totalItems());
  const toggleCart = useCartStore((s) => s.toggleCart);

  const openNow = (href: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpenMenu(href);
  };
  const closeSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenMenu(null), CLOSE_DELAY_MS);
  };

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  // Escape closes the menu. A hover menu with no keyboard exit traps anyone
  // navigating by keyboard once it has opened on focus. The search panel goes
  // through the same handler — Escape is what people press to dismiss a search
  // field, and having it work in one place but not the other is worse than
  // neither.
  useEffect(() => {
    if (!openMenu && !searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenMenu(null);
      setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu, searchOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-ink/5 bg-cream/90 backdrop-blur-md">
      <nav className="container-wovenne flex items-center justify-between py-4">
        {/* Emblem alone — the wordmark belongs to the hero, where it is stated
            once at full size instead of repeated small on every page. The
            aria-label carries the name for anyone who cannot see the mark. */}
        <Link
          href="/"
          aria-label="THE WOVENNE — home"
          className="flex items-center text-ink transition-opacity hover:opacity-70"
        >
          <Image
            src="/logo_emblem_transparent.png"
            alt=""
            width={3096}
            height={2792}
            priority
            sizes="48px"
            className="h-10 w-auto sm:h-11"
          />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => {
            const children = link.children ?? [];
            const hasMenu = children.length > 0;
            const isOpen = openMenu === link.href;

            if (!hasMenu) {
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="font-body text-sm uppercase tracking-widest text-ink/80 transition-colors hover:text-terracotta"
                >
                  {link.label}
                </Link>
              );
            }

            return (
              <div
                key={link.href}
                className="relative"
                onMouseEnter={() => openNow(link.href)}
                onMouseLeave={closeSoon}
                // Opens on keyboard focus too, so the sub-categories are not
                // reachable by mouse only.
                onFocus={() => openNow(link.href)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setOpenMenu(null);
                  }
                }}
              >
                <Link
                  href={link.href}
                  aria-expanded={isOpen}
                  aria-haspopup="true"
                  className="flex items-center gap-1.5 font-body text-sm uppercase tracking-widest text-ink/80 transition-colors hover:text-terracotta"
                >
                  {link.label}
                  <ChevronDown
                    aria-hidden
                    className={`h-3.5 w-3.5 transition-transform duration-200 ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </Link>

                <AnimatePresence>
                  {isOpen && (
                    <motion.div
                      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                      // pt-3 is a hover bridge, not spacing: without a
                      // continuous hoverable area the pointer crosses a gap
                      // between the word and the panel and the menu closes.
                      className="absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3"
                    >
                      <div className="min-w-[14rem] rounded-xl border border-ink/10 bg-cream p-2 shadow-soft">
                        <ul>
                          {children.map((child) => (
                            <li key={child.href}>
                              <Link
                                href={child.href}
                                onClick={() => setOpenMenu(null)}
                                className="block rounded-lg px-4 py-2.5 font-body text-sm text-ink/80 transition-colors hover:bg-linen/60 hover:text-terracotta"
                              >
                                {child.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-5">
          <button
            onClick={() => setSearchOpen((v) => !v)}
            aria-label={searchOpen ? "Close search" : "Search"}
            aria-expanded={searchOpen}
            className="text-ink transition-colors hover:text-terracotta"
          >
            <Search className="h-6 w-6" strokeWidth={1.5} />
          </button>

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

      {/* Expands below the bar rather than replacing the nav in place: the row
          keeps its height, so nothing under the header jumps when it opens. */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-ink/5"
          >
            <div className="container-wovenne py-4">
              <div className="mx-auto max-w-xl">
                <SearchField
                  autoFocus
                  onSubmitted={() => setSearchOpen(false)}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
              {navLinks.map((link) => {
                const children = link.children ?? [];
                const hasMenu = children.length > 0;
                const isExpanded = expandedMobile === link.href;

                return (
                  <div key={link.href}>
                    <div className="flex items-center justify-between">
                      <Link
                        href={link.href}
                        onClick={() => setMobileOpen(false)}
                        className="font-body text-sm uppercase tracking-widest text-ink/80"
                      >
                        {link.label}
                      </Link>

                      {/* A separate control from the link: tapping the word
                          should still go to the section, so the chevron is what
                          expands. Merging them would make the section itself
                          unreachable on a phone. */}
                      {hasMenu && (
                        <button
                          onClick={() =>
                            setExpandedMobile(isExpanded ? null : link.href)
                          }
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? "Hide" : "Show"} ${link.label} categories`}
                          className="p-1 text-ink/60"
                        >
                          <ChevronDown
                            className={`h-4 w-4 transition-transform duration-200 ${
                              isExpanded ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                      )}
                    </div>

                    <AnimatePresence>
                      {hasMenu && isExpanded && (
                        <motion.ul
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          {children.map((child) => (
                            <li key={child.href}>
                              <Link
                                href={child.href}
                                onClick={() => {
                                  setMobileOpen(false);
                                  setExpandedMobile(null);
                                }}
                                className="block py-2 pl-4 font-body text-sm text-ink/70"
                              >
                                {child.label}
                              </Link>
                            </li>
                          ))}
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}

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

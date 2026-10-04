"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Heart, Menu, Search, ShoppingBag, X } from "lucide-react";
import { useCartStore } from "@/lib/store";
import AccountEntry from "@/components/account/AccountEntry";
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
const ACCOUNT_HREF = "/in/account/profile";
const WISHLIST_HREF = "/in/account/wishlist";

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
  // Whether the open menu was opened deliberately (click, Enter, Space) rather
  // than by the pointer passing over it. A deliberate open stays open when the
  // pointer leaves; a hover open closes as it always did.
  const pinned = useRef(false);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const desktopNav = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const totalItems = useCartStore((s) => s.totalItems());
  const toggleCart = useCartStore((s) => s.toggleCart);

  const openNow = (href: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openMenu !== href) pinned.current = false;
    setOpenMenu(href);
  };
  const closeSoon = () => {
    if (pinned.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenMenu(null), CLOSE_DELAY_MS);
  };
  const closeMenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    pinned.current = false;
    setOpenMenu(null);
  };

  /**
   * THE SECTION NAME OPENS ITS MENU; IT DOES NOT NAVIGATE.
   *
   * Women, Men and Jewellery were links that also opened a dropdown, and the
   * dropdown already ends in "View all Women" — two ways to the same page, one
   * of them easy to trigger by accident while reaching for a sub-category. The
   * name is now a disclosure button and "View all …" is the one way to the
   * section page. The section routes themselves are untouched.
   *
   * Click, Enter and Space all arrive here (a real button). A hover-opened
   * menu is pinned by the click rather than toggled shut under the pointer; a
   * pinned menu closes on a second click, Escape, or focus/click outside.
   */
  const onTrigger = (href: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openMenu === href && pinned.current) {
      closeMenu();
      return;
    }
    pinned.current = true;
    setOpenMenu(href);
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
      // Focus goes back to the section name when it was inside that menu, so
      // a keyboard user is left where they started rather than on <body>.
      const trigger = openMenu ? triggers.current.get(openMenu) : undefined;
      const inMenu = !!trigger?.parentElement?.contains(document.activeElement);
      closeMenu();
      setSearchOpen(false);
      if (inMenu) trigger?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu, searchOpen]);

  // A pinned menu has no pointer to leave it, so a click anywhere outside the
  // desktop nav closes it.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!desktopNav.current?.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openMenu]);

  return (
    <header className="sticky top-0 z-40 border-b border-ink/5 bg-cream/90 backdrop-blur-md">
      <nav className="container-wovenne flex items-center justify-between py-4">
        {/* Emblem alone — the wordmark belongs to the hero, where it is stated
            once at full size instead of repeated small on every page. The
            aria-label carries the name for anyone who cannot see the mark. */}
        <Link
          href="/in"
          aria-label="THE WOVENNE — home"
          // shrink-0: a brand mark is not slack. Without it the emblem is the
          // flex item that yields when the row is short, which is how it came
          // to be drawn 9px wide at 768 — a distortion that looked like a
          // design choice rather than the overflow it actually was.
          className="flex shrink-0 items-center text-ink transition-opacity hover:opacity-70"
        >
          {/* THE DIMENSIONS DESCRIBE THE SLOT, NOT THE FILE. Passing the
              emblem's intrinsic 3096×2792 alongside a fixed-pixel `sizes` made
              Next offer every configured width for a 49px mark, and name the
              largest of them in `src` — so a client that ignores srcset fetched
              a 1920-wide emblem (48 write units) to draw it at 49.

              Rendered size is unchanged: `h-10 sm:h-11 w-auto` still decides
              that, as it always did. These numbers only set the aspect ratio
              that reserves space before load, and the 1x/2x ladder Next builds
              for a genuinely fixed-size image. Two candidates now: 64 and 128.

              A 3x screen takes the 2x file, which is Next's deliberate default
              and its own documented reasoning — the third pixel is not visible
              on an emblem this size and costs several times the bytes. */}
          <Image
            src="/logo_emblem_transparent.png"
            alt=""
            width={49}
            height={44}
            priority
            className="h-10 w-auto sm:h-11"
          />
        </Link>

        {/*
          lg, NOT md. The desktop nav needs 668px of its own, plus 156px of
          controls and a 49px emblem — 873px of inner width. Below 1024 the
          container gives it `sm:px-8`, so the viewport has to be 937px before
          that fits, and md is 768. What happened in between was not a graceful
          squeeze: the row wrapped to 93px from 768 to ~820, and the emblem was
          crushed to NINE pixels wide at 768, still only 42 at 830 and 46 at
          900, reaching its true 49 only at 1024. The brand mark was silently
          absorbing a real horizontal overflow.

          1024 rather than a custom 940: it is a named breakpoint already used
          by this header's own container, it is where that container widens to
          `lg:px-12`, and it leaves 45px spare instead of zero.
        */}
        <div ref={desktopNav} className="hidden items-center gap-8 lg:flex">
          {navLinks.map((link) => {
            const children = link.children ?? [];
            const hasMenu = children.length > 0;
            const isOpen = openMenu === link.href;
            const menuId = `nav-menu-${link.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

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
                // Hover still opens it — an enhancement for a mouse, not the
                // only way in. Keyboard focus no longer opens it on its own:
                // a Tab past the header should not unfold three menus.
                onMouseEnter={() => openNow(link.href)}
                onMouseLeave={closeSoon}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    if (openMenu === link.href) closeMenu();
                  }
                }}
              >
                <button
                  type="button"
                  ref={(el) => {
                    if (el) triggers.current.set(link.href, el);
                    else triggers.current.delete(link.href);
                  }}
                  onClick={() => onTrigger(link.href)}
                  aria-expanded={isOpen}
                  aria-controls={menuId}
                  className="flex items-center gap-1.5 rounded-sm font-body text-sm uppercase tracking-widest text-ink/80 transition-colors hover:text-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-4 focus-visible:ring-offset-cream"
                >
                  {link.label}
                  <ChevronDown
                    aria-hidden
                    className={`h-3.5 w-3.5 transition-transform duration-200 ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

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
                      <div
                        id={menuId}
                        className="min-w-[14rem] rounded-xl border border-ink/10 bg-cream p-2 shadow-soft"
                      >
                        <ul>
                          {children.map((child) => (
                            <li key={child.href}>
                              <Link
                                href={child.href}
                                onClick={closeMenu}
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

                {/* THE CLOSED MENU'S LINKS STAY IN THE HTML, HIDDEN.
                    Mounting the panel only while open (PR #172) left the
                    server-rendered page with no link at all to Women, Men,
                    Jewellery or any sub-category — every page shipped a
                    header a crawler could not follow past "Our Story". These
                    are the same links the open panel shows, in the same
                    order; `hidden` keeps them out of view, out of the tab
                    order and out of the accessibility tree, so nothing about
                    the menu's behaviour changes. The section name is still a
                    button, and "View all …" is still the way to the section.
                    No id: the open panel above owns menuId, and the two
                    coexist for the length of its exit animation. */}
                {!isOpen && (
                  <ul hidden>
                    {children.map((child) => (
                      <li key={child.href}>
                        <Link href={child.href} prefetch={false}>
                          {child.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-5">
          <button
            onClick={() => setSearchOpen((v) => !v)}
            aria-label={searchOpen ? "Close search" : "Search"}
            aria-expanded={searchOpen}
            className="-m-2.5 p-2.5 text-ink transition-colors hover:text-terracotta"
          >
            <Search className="h-6 w-6" strokeWidth={1.5} />
          </button>

          <Link
            href={WISHLIST_HREF}
            aria-label="Wishlist"
            className="-m-2.5 p-2.5 text-ink transition-colors hover:text-terracotta"
          >
            <Heart className="h-6 w-6" strokeWidth={1.5} />
          </Link>

          {/* A guest gets the choice modal here rather than a silent jump to
              the login page; a signed-in customer gets the plain link. */}
          <AccountEntry href={ACCOUNT_HREF} />

          <button
            onClick={toggleCart}
            aria-label="Open cart"
            className="relative -m-2.5 p-2.5 text-ink transition-colors hover:text-terracotta"
          >
            <ShoppingBag className="h-6 w-6" />
            {totalItems > 0 && (
              <span className="pointer-events-none absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-full bg-terracotta text-[10px] font-semibold text-cream">
                {totalItems}
              </span>
            )}
          </button>

          {/* aria-expanded because this control now carries the navigation for
              every tablet, not just phones — moving the desktop nav to `lg`
              widened its responsibility from <768 to <1024. The search button
              beside it already announces its state; this one did not. */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={mobileOpen}
            className="-m-2.5 p-2.5 text-ink lg:hidden"
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
            className="overflow-hidden border-t border-ink/5 lg:hidden"
          >
            <div className="container-wovenne flex flex-col gap-4 py-4">
              {navLinks.map((link) => {
                const children = link.children ?? [];
                const hasMenu = children.length > 0;
                const isExpanded = expandedMobile === link.href;
                const groupId = `nav-group-${link.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

                return (
                  <div key={link.href}>
                    {/* A SECTION IS A GROUP TO OPEN, NOT A PAGE TO LEAVE FOR.
                        The word used to navigate and only the chevron beside it
                        expanded, so the obvious tap took a phone away before it
                        had seen the sub-categories. The whole row is now one
                        button; the group it opens ends in "View all …", which is
                        the way to the section page. */}
                    {hasMenu ? (
                      <button
                        type="button"
                        onClick={() => setExpandedMobile(isExpanded ? null : link.href)}
                        aria-expanded={isExpanded}
                        aria-controls={groupId}
                        className="flex w-full items-center justify-between py-1 text-left font-body text-sm uppercase tracking-widest text-ink/80"
                      >
                        {link.label}
                        <ChevronDown
                          aria-hidden
                          className={`h-4 w-4 text-ink/60 transition-transform duration-200 ${
                            isExpanded ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                    ) : (
                      <Link
                        href={link.href}
                        onClick={() => setMobileOpen(false)}
                        className="block py-1 font-body text-sm uppercase tracking-widest text-ink/80"
                      >
                        {link.label}
                      </Link>
                    )}

                    <AnimatePresence>
                      {hasMenu && isExpanded && (
                        <motion.ul
                          id={groupId}
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

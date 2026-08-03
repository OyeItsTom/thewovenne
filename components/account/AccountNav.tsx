"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/account/orders", label: "Orders" },
  { href: "/account/wishlist", label: "Wishlist" },
  { href: "/account/preferences", label: "Preferences" },
];

/** Moves between the account pages without going back up to the header. */
export default function AccountNav() {
  const pathname = usePathname();

  return (
    <nav className="flex justify-center gap-8 border-b border-ink/10">
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "px-1 py-3 text-sm uppercase tracking-widest transition-colors",
              active
                ? "border-b-2 border-terracotta text-ink"
                : "text-ink/50 hover:text-ink"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

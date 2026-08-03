"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Heart, Package, Settings, User } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The account sidebar.
 *
 * A vertical list on desktop and a horizontal strip on mobile — the same
 * sections either way, so a customer who learns the layout on a phone finds it
 * where they expect on a laptop.
 *
 * Four sections, and Settings is the last of them on purpose. Profile is what a
 * customer comes here to look at; changing a password, editing preferences or
 * closing the account are things they come here to DO, occasionally, and they
 * are gathered in one place rather than stacked under the details.
 */
const LINKS = [
  { href: "/account/profile", label: "Profile", icon: User },
  { href: "/account/orders", label: "Orders", icon: Package },
  { href: "/account/wishlist", label: "Wishlist", icon: Heart },
  { href: "/account/settings", label: "Settings", icon: Settings },
];

export default function AccountNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Account">
      <ul className="flex gap-1 overflow-x-auto border-b border-ink/10 lg:flex-col lg:gap-0 lg:overflow-visible lg:border-b-0 lg:border-r">
        {LINKS.map((link) => {
          const active = pathname === link.href;
          const Icon = link.icon;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 whitespace-nowrap px-4 py-3 text-sm transition-colors",
                  "lg:border-b-0 lg:border-r-2 lg:px-5",
                  active
                    ? "border-b-2 border-terracotta font-medium text-ink lg:border-terracotta"
                    : "border-b-2 border-transparent text-ink/55 hover:text-ink lg:border-transparent"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

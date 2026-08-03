import { getNavCategoryTree } from "@/lib/storefront";
import NavbarClient, { type NavItem } from "./NavbarClient";

/**
 * Server component: the category links are data-driven, so they're resolved on
 * the server and handed to the client shell already built — no post-hydration
 * flash of a half-empty nav.
 */
export default async function Navbar() {
  const tree = await getNavCategoryTree();

  // Parent categories first (DB sort_order → Men, then Women), then the
  // evergreen links. If no parent qualifies yet the nav quietly falls back to
  // just those two — clean, never an empty bar.
  const navLinks: NavItem[] = [
    ...tree.map((parent) => ({
      href: `/${parent.slug}`,
      label: parent.name,
      // The sub-categories the mega-menu opens. Already filtered upstream to
      // visible ones that actually hold products, so a menu never offers a link
      // to an empty listing.
      children: parent.children.map((child) => ({
        href: `/${parent.slug}/${child.slug}`,
        label: child.name,
      })),
    })),
    // /about, not /#story — the story is no longer a homepage section, and the
    // anchor it pointed at went with it. A link that silently scrolls nowhere
    // is the classic leftover of moving content.
    { href: "/about", label: "Our Story" },
    { href: "/journal", label: "Journal" },
  ];

  return <NavbarClient navLinks={navLinks} />;
}

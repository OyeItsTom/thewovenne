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
    })),
    { href: "/#story", label: "Our Story" },
    { href: "/journal", label: "Journal" },
  ];

  return <NavbarClient navLinks={navLinks} />;
}

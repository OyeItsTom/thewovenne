import { getNavCategoryTree } from "@/lib/storefront";
import NavbarClient, { type NavItem } from "./NavbarClient";
import { cPath } from "@/lib/country";

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
      href: cPath(`/${parent.slug}`),
      label: parent.name,
      // The sub-categories the mega-menu opens. Already filtered upstream to
      // visible ones that actually hold products, so a menu never offers a link
      // to an empty listing.
      children: parent.children.map((child) => ({
        href: cPath(`/${parent.slug}/${child.slug}`),
        label: child.name,
      })),
    })),
    // /about, not /#story — the story is no longer a homepage section, and the
    // anchor it pointed at went with it. A link that silently scrolls nowhere
    // is the classic leftover of moving content.
    { href: "/in/about", label: "Our Story" },
    // WORN BY YOU TAKES JOURNAL'S PLACE, rather than joining it. The primary bar
    // holds five links before it starts wrapping on a narrow phone, and the
    // photographs customers send us do more selling than an essay does — so the
    // scarce slot goes to them.
    //
    // Journal is not deleted, only demoted: it keeps its route, its sitemap
    // entry and its footer link. See the Explore column in Footer.tsx.
    { href: "/in/customer-style", label: "Worn by You" },
  ];

  return <NavbarClient navLinks={navLinks} />;
}

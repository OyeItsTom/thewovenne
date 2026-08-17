import type { FooterContent, FooterExploreItem } from "./types";

/**
 * The footer's rules, as pure functions.
 *
 * WHY THIS IS NOT IN THE COMPONENT. Everything here decides whether something
 * a human typed into the admin is safe to put in an href — an internal path, a
 * mailto, an Instagram profile, a WhatsApp number. That is exactly the kind of
 * decision that should be readable on its own and testable without a browser,
 * because the failure mode is not a wonky layout, it is a link that does
 * something the admin did not intend.
 *
 * NO REACT, NO NEXT, NO DATABASE. The component reads content and renders; the
 * judgement lives here.
 *
 * The shape of every answer is the same: a valid value, or null. A caller
 * cannot spread null into an href without deciding what "not configured" means,
 * and the answer is always to render nothing rather than something broken —
 * the same rule lib/whatsapp has followed since #116.
 */

/** One resolved Explore link, ready to render. */
export interface ResolvedExploreItem {
  id: string;
  label: string;
  /** An internal path WITHOUT the market prefix, e.g. "/shop". */
  href: string;
}

/** A published page as the footer needs to see it. */
export interface FooterPage {
  slug: string;
  title: string;
}

/**
 * The five links that are routes rather than pages.
 *
 * These exist in the application, not in the CMS, so they cannot be discovered
 * the way pages are. They are listed here rather than in the component so that
 * the ordering and renaming rules apply to them identically.
 */
export const FOOTER_FIXED_ITEMS: ResolvedExploreItem[] = [
  { id: "home", label: "Home", href: "/" },
  { id: "shop", label: "Shop", href: "/shop" },
  { id: "about", label: "Our Story", href: "/about" },
  { id: "journal", label: "Journal", href: "/journal" },
  { id: "customer-style", label: "Worn by You", href: "/customer-style" },
];

/** The page slugs the footer already links by hand, so they are not repeated. */
export const FOOTER_HARDCODED_PAGE_SLUGS = new Set(["about"]);

/** The id an override uses for a CMS page. */
export function pageItemId(slug: string): string {
  return `page:${slug}`;
}

/**
 * An internal path, or null.
 *
 * ONLY OUR OWN PATHS. The footer's Explore column navigates the site, so the
 * answer to "can the admin type an external address here" is no — not because
 * an external link is wrong in general, but because this is the one field where
 * allowing it buys nothing and costs a scheme check on every save forever.
 *
 * Rejected, and why:
 *  - anything without a leading "/" — including "javascript:", "data:" and
 *    "mailto:", which is the whole point of the check
 *  - "//host" — protocol-relative, an external address wearing a path's clothes
 *  - "/\host" and any backslash — some browsers normalise "\" to "/", so this
 *    is "//host" spelled differently
 *  - whitespace and control characters anywhere, which is how a scheme gets
 *    smuggled past a naive prefix test ("\njavascript:...")
 */
export function safeInternalHref(value: string | null | undefined): string | null {
  const href = (value ?? "").trim();
  if (!href) return null;
  if (!href.startsWith("/")) return null;
  if (href.startsWith("//")) return null;
  if (href.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(href)) return null;
  return href;
}

/**
 * The Explore column: what exists, adjusted by what the admin has said.
 *
 * DEFAULTS COME FROM REALITY. The list starts as the five built-in routes plus
 * every published page marked "shown in footer", in the order the pages already
 * carry. A page published tomorrow appears tomorrow, with no admin action — the
 * behaviour the footer has always had, and worth keeping.
 *
 * OVERRIDES ONLY ADJUST. A stored row can rename a link, hide it, point it
 * somewhere else internal, or move it. It cannot invent one: an override whose
 * id matches nothing that exists is ignored, so a hidden entry left behind by a
 * deleted page stays quietly inert instead of resurrecting as a broken link.
 *
 * ORDER IS SEPARATE FROM EVERYTHING ELSE, and this is the subtle part. A stored
 * row can exist purely to rename a link, and renaming is not rearranging — an
 * early version of this treated any mention as an instruction about position,
 * so a single label correction dragged that link to the top of the column.
 *
 * The rule instead: the rows the admin's list mentions keep the SET of places
 * they already occupy, and are dealt back into those places in the order the
 * list gives. Links the list does not mention do not move at all. So mentioning
 * one link reorders nothing, mentioning two swaps exactly those two, and the
 * editor — which saves every row in display order — arranges the whole column.
 * A page published later is mentioned by nobody and therefore keeps its natural
 * place at the end.
 */
export function resolveExploreItems(
  pages: FooterPage[],
  overrides: FooterExploreItem[] | null | undefined
): ResolvedExploreItem[] {
  const discovered: ResolvedExploreItem[] = [
    ...FOOTER_FIXED_ITEMS,
    ...pages
      .filter((page) => !FOOTER_HARDCODED_PAGE_SLUGS.has(page.slug))
      .map((page) => ({
        id: pageItemId(page.slug),
        label: page.title,
        href: `/${page.slug}`,
      })),
  ];

  const stored = Array.isArray(overrides) ? overrides : [];
  // First mention wins, so a malformed list with a repeated id cannot claim two
  // places and leave a hole where another link should be.
  const byId = new Map<string, FooterExploreItem>();
  for (const item of stored) if (!byId.has(item.id)) byId.set(item.id, item);

  // The places the mentioned links already occupy, and which of them — in the
  // admin's order — go back into those places.
  const slots: number[] = [];
  discovered.forEach((item, index) => {
    if (byId.has(item.id)) slots.push(index);
  });
  const claimants = [...byId.keys()]
    .map((id) => discovered.findIndex((item) => item.id === id))
    .filter((index) => index >= 0);

  const arranged = [...discovered];
  slots.forEach((slot, position) => {
    arranged[slot] = discovered[claimants[position]];
  });

  return arranged
    .map((item) => {
      const override = byId.get(item.id);
      const label = (override?.label ?? "").trim() || item.label;
      return {
        id: item.id,
        label,
        href: safeInternalHref(override?.href) ?? item.href,
        visible: override?.visible !== false && label.length > 0,
      };
    })
    .filter((item) => item.visible)
    .map(({ visible: _visible, ...item }) => item);
}

/**
 * A mailto address, or null.
 *
 * The shape check is deliberately ordinary — one @, something either side, a
 * dot in the domain. What matters more is what is refused: whitespace, control
 * characters, commas and question marks. A newline or a "?" in a mailto turns
 * the address into a header list, so an address field would become a way to
 * pre-address a customer's mail client to somebody else entirely.
 */
export function safeEmailAddress(value: string | null | undefined): string | null {
  const email = (value ?? "").trim();
  if (!email || email.length > 254) return null;
  if (/[\s,;:?<>()[\]\\"]/.test(email)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(email)) return null;
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return null;
  return email;
}

export interface ResolvedInstagram {
  /** Without the @, e.g. "thewovenne". */
  username: string;
  /** What the customer sees. */
  handle: string;
  url: string;
}

/**
 * The Instagram row, or null.
 *
 * THE USERNAME IS THE POINT. An icon on its own tells somebody there is an
 * account but not which one, so the account name is what is displayed and what
 * the accessible name contains. The address is never shown: nobody reads a
 * profile URL, and printing one where a handle belongs is what makes a footer
 * look assembled rather than typeset.
 *
 * A username alone is enough — the address is derived from it. A stored address
 * is used only when it genuinely points at Instagram, so a mistyped or pasted
 * tracking URL falls back to the profile the handle names rather than sending
 * the customer somewhere unexpected.
 */
export function resolveInstagram(
  instagram: FooterContent["instagram"] | null | undefined
): ResolvedInstagram | null {
  if (!instagram || instagram.visible === false) return null;

  // Tolerant of what a human types: a leading @, a pasted profile URL, or a
  // trailing slash. Intolerant of anything Instagram itself would not accept.
  const raw = (instagram.username ?? "").trim();
  const username = raw
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/\/+$/, "")
    .trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) return null;

  const derived = `https://www.instagram.com/${username}`;
  const stored = (instagram.url ?? "").trim();
  return {
    username,
    handle: `@${username}`,
    url: isInstagramUrl(stored) ? stored : derived,
  };
}

/** True only for an https address on Instagram's own domain. */
export function isInstagramUrl(value: string | null | undefined): boolean {
  const candidate = (value ?? "").trim();
  if (!candidate) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname === "instagram.com" || url.hostname === "www.instagram.com";
}

/**
 * What the footer should show, once the content has been read.
 *
 * Kept as one function so the component has no conditions of its own beyond
 * "render this or do not". Every branch that decides whether a row exists is
 * here, in something a test can call.
 */
export interface ResolvedConnectRow {
  kind: "whatsapp" | "email" | "instagram";
  href: string;
  /** The visible text. */
  text: string;
  /** The accessible name, which always says which account or address it is. */
  label: string;
  external: boolean;
}

export function resolveConnectRows(
  footer: FooterContent,
  whatsappHref: string | null
): ResolvedConnectRow[] {
  const rows: ResolvedConnectRow[] = [];

  if (footer.whatsapp?.visible !== false && whatsappHref) {
    const text = (footer.whatsapp?.label ?? "").trim() || "WhatsApp";
    rows.push({
      kind: "whatsapp",
      href: whatsappHref,
      text,
      label: `${text} — message THE WOVENNE`,
      external: true,
    });
  }

  const email = footer.email?.visible === false ? null : safeEmailAddress(footer.email?.address);
  if (email) {
    rows.push({
      kind: "email",
      href: `mailto:${email}`,
      text: email,
      label: `Email THE WOVENNE at ${email}`,
      external: false,
    });
  }

  const instagram = resolveInstagram(footer.instagram);
  if (instagram) {
    rows.push({
      kind: "instagram",
      href: instagram.url,
      text: instagram.handle,
      label: `THE WOVENNE on Instagram (${instagram.handle})`,
      external: true,
    });
  }

  return rows;
}

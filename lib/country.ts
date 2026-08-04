/**
 * Country-prefixed URLs.
 *
 * Every customer-facing path carries a market prefix from day one —
 * /in/women/sarees/kerala-kasavu — so adding the UK or the UAE later is a new
 * prefix rather than a migration. Moving URLs after people have bookmarked and
 * shared them costs rankings and breaks links; doing it before launch costs an
 * afternoon.
 *
 * /admin is DELIBERATELY OUTSIDE this. It is one back office for the whole
 * business, not a per-market storefront: there is one catalogue, one order
 * list, one set of staff. Prefixing it would imply a UK admin exists separately
 * from an Indian one, and would mean every future market duplicated the entire
 * dashboard.
 */

export const COUNTRIES = ["in"] as const;
export type Country = (typeof COUNTRIES)[number];

/** The only live market. Bare paths redirect here. */
export const DEFAULT_COUNTRY: Country = "in";

export function isCountry(value: string): value is Country {
  return (COUNTRIES as readonly string[]).includes(value);
}

/**
 * Build a storefront path for a market.
 *
 * Call this instead of writing "/in/..." by hand. When a second market opens,
 * the links that need to become country-aware are exactly the callers of this
 * function — findable in one grep, rather than scattered as string literals.
 *
 *   cPath("/shop")            → "/in/shop"
 *   cPath("/women/sarees")    → "/in/women/sarees"
 *   cPath("/")                → "/in"
 */
export function cPath(path = "/", country: Country = DEFAULT_COUNTRY): string {
  if (!path.startsWith("/")) path = `/${path}`;
  // "/" would otherwise produce "/in/", which is a second URL for the same
  // page and exactly the kind of duplicate a canonical tag has to clean up.
  return path === "/" ? `/${country}` : `/${country}${path}`;
}

/**
 * Normalise a link an ADMIN typed into the site's own path shape.
 *
 * The admin types "/shop" or "/women/sarees" — they should not have to know
 * that markets exist, and the same stored value has to keep working when the
 * UK opens. So the prefix is added at render rather than baked into the data:
 * no migration of existing content, and one stored link serves every market.
 *
 * Anything already prefixed, external, or an anchor/mailto is left alone.
 */
export function adminHref(href: string, country: Country = DEFAULT_COUNTRY): string {
  const value = (href ?? "").trim();
  if (!value) return value;
  // Absolute URLs, anchors, mail and phone links are not ours to rewrite.
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  if (isUnprefixed(value)) return value;
  const first = value.split("/")[1] ?? "";
  if (isCountry(first)) return value;
  return cPath(value, country);
}

/**
 * Paths that are NOT country-prefixed, and never redirect into a market.
 * Everything else under the site root belongs to a storefront.
 */
export const UNPREFIXED_PREFIXES = [
  "/admin",
  "/api",
  "/_next",
  "/sitemap.xml",
  "/robots.txt",
  "/favicon.ico",
  "/icon.png",
  "/apple-icon.png",
];

export function isUnprefixed(pathname: string): boolean {
  return UNPREFIXED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

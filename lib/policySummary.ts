import type { SitePage } from "./pages";
import { isPlaceholderFact } from "./productInfo";
import { rootSlugHref } from "./urls";

/**
 * What a product page says about delivery and returns.
 *
 * NOT WRITTEN HERE. Each line is the published INTRO of the policy page it
 * points to — the one-sentence summary the shop wrote at the top of that page —
 * quoted word for word. A summary composed in code would be a second statement
 * of the policy, and the day the page changes the product page would carry on
 * promising the old terms to every customer who never clicked through. Quoting
 * the page cannot disagree with the page.
 *
 * NOTHING IS FILLED IN. No published page, or a page with no intro, gives null
 * and the row is not shown: no "Easy returns", no "Fast delivery", no default.
 * The link is still the page's own URL and its own title, so the words a
 * customer clicks name the page they land on.
 */

export const POLICY_PAGES = {
  delivery: "shipping-delivery",
  returns: "returns-exchanges",
} as const;

export type PolicyKey = keyof typeof POLICY_PAGES;

const LABEL: Record<PolicyKey, string> = {
  delivery: "Delivery",
  returns: "Returns",
};

export interface PolicySummary {
  key: PolicyKey;
  label: string;
  /** The page's published intro, trimmed — never edited. */
  summary: string;
  href: string;
  /** Names the destination, e.g. "Read the Shipping & Delivery policy". */
  linkText: string;
}

export function policySummary(
  key: PolicyKey,
  page: Pick<SitePage, "slug" | "title" | "intro"> | null
): PolicySummary | null {
  // The page must be the one this row is about — a stray row never stands in.
  if (!page || page.slug !== POLICY_PAGES[key]) return null;
  const summary = page.intro?.trim();
  if (!summary || isPlaceholderFact(summary)) return null;
  const title = page.title.trim() || LABEL[key];
  return {
    key,
    label: LABEL[key],
    summary,
    href: rootSlugHref(page.slug),
    linkText: `Read the ${title} policy`,
  };
}

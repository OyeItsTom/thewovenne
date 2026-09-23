import { customerUrl, PRODUCTION_ORIGIN } from "./seo";
import { cPath } from "./country";

/**
 * The structured data Wovenne tells Google, built as pure functions.
 *
 * NO REACT, NO NEXT, NO DATABASE. Every node here is a set of CLAIMS about the
 * business and its stock, and a claim that cannot be checked without a running
 * site is a claim nobody checks. Callers fetch; this decides what may be said.
 *
 * ── THE RULE THAT SHAPES EVERY FUNCTION BELOW ──
 *
 * Nothing is invented. Each property traces to something already visible on the
 * page or already authoritative in the database, and anything we cannot source
 * is ABSENT rather than guessed. That is not only Google's structured-data
 * policy — where invented markup is a manual-action risk — it is the same rule
 * migration 0051 states about heritage copy: inventing provenance for handloom
 * cloth damages the one claim the shop is built on.
 *
 * Deliberately absent, each for a stated reason (see K in the SEO-3 notes):
 *   gtin, mpn        — no such data exists anywhere in the model
 *   sku              — exists, but is derived from the slug (0038's
 *                      sku_from_slug) and is admin-only; it would restate the
 *                      URL as an identifier and tell Google nothing
 *   itemCondition    — no field records it; true as it almost certainly is,
 *                      "new" is not a fact this codebase holds
 *   ProductGroup     — one URL per product, size chosen client-side, no
 *                      per-size price: there are no variant entities to group
 *   AggregateOffer   — the same reason; one product is one offer
 *   review nodes     — aggregateRating alone earns the star snippet; quoting
 *                      customers verbatim adds eligibility for nothing and puts
 *                      user-written text into every crawl
 *   returns/shipping — SEO-4 owns the merchant facts, and the pages those
 *                      policies would point at do not exist yet
 */

export const BRAND_NAME = "THE WOVENNE";

/** The canonical entity URL: the site's own root, not a market inside it. */
export const SITE_URL = `${PRODUCTION_ORIGIN}/`;

/**
 * The logo, absolute.
 *
 * Google asks for at least 112x112, crawlable and indexable. This is the file
 * already serving as the default share image — 2275x2275, public, and covered
 * by robots.txt's Allow — so the mark Google associates with the business is the
 * mark already in use rather than a second one introduced for schema.
 */
export const LOGO_URL = customerUrl("/logo_illustrated.png");

export type Availability =
  | "https://schema.org/InStock"
  | "https://schema.org/OutOfStock";

export interface ProductNodeInput {
  name: string;
  /** Path from productHref() — the same value the page's canonical carries. */
  href: string;
  /** Absolute image URLs, cover first. */
  images: string[];
  /** products.description. Null when nobody has written one. */
  description: string | null;
  /** What the customer is charged, from effectivePrice(). */
  price: number;
  /**
   * True when NOTHING can be bought — from stockState(), which is the same
   * authority the visible page uses to print "Sold out".
   */
  soldOut: boolean;
  /** From getRating(). Marked up only when total > 0. */
  rating: { average: number | null; total: number };
  /**
   * When an active discount ends. The discounted price genuinely stops being
   * available then, which is what priceValidUntil means. Null the rest of the
   * time, and then no date is claimed.
   */
  priceValidUntil?: string | null;
}

/**
 * One product, one offer.
 *
 * DESCRIPTION IS THE PRODUCT'S OWN OR NOTHING. generateMetadata falls back to
 * "Authentic handloom linen from Kerala." for a product nobody has written up,
 * which is fine for a meta description — it is a summary of the shop — and
 * wrong here, where `description` is a statement about THIS piece. A third of
 * the catalogue would otherwise carry one identical sentence as its own
 * description, and one of those products is a copper and cubic-zirconia
 * necklace.
 *
 * AVAILABILITY IS BINARY, and comes from the same stockState() call the page
 * renders from. A sized product is InStock when at least one size has stock,
 * which is exactly when its Add to Cart can succeed; a sizeless one follows its
 * own stock column. Structured data that disagreed with the button would be
 * both a policy breach and a lie to a customer.
 */
export function productNode(input: ProductNodeInput) {
  const url = customerUrl(input.href);

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    url,
    // Absent when the gallery is empty rather than pointing at a placeholder:
    // Google requires image for a merchant listing, and a logo is not a product
    // photograph.
    image: input.images.length > 0 ? input.images : undefined,
    description: input.description ?? undefined,
    brand: { "@type": "Brand", name: BRAND_NAME },
    offers: {
      "@type": "Offer",
      url,
      price: input.price,
      priceCurrency: "INR",
      availability: (input.soldOut
        ? "https://schema.org/OutOfStock"
        : "https://schema.org/InStock") satisfies Availability,
      priceValidUntil: input.priceValidUntil ?? undefined,
      seller: { "@type": "Organization", name: BRAND_NAME },
    },
    aggregateRating: aggregateRatingNode(input.rating),
  };
}

/**
 * The star rating, or nothing.
 *
 * GATED ON EXACTLY WHAT THE PAGE SHOWS. ProductDetail renders its Stars block
 * behind `rating.total > 0 && rating.average !== null`, and Google requires
 * that a marked-up aggregate rating be visible to the person who arrives. One
 * condition, written once, so the two can never drift — the failure mode being
 * a page that promises stars in the results and shows none on arrival.
 *
 * bestRating and worstRating are left out on purpose: Google assumes 5 and 1,
 * which is the scale product_reviews stores (migration 0036).
 */
export function aggregateRatingNode(rating: { average: number | null; total: number }) {
  if (rating.total <= 0 || rating.average === null) return undefined;
  return {
    "@type": "AggregateRating",
    ratingValue: rating.average,
    reviewCount: rating.total,
  };
}

export interface Crumb {
  name: string;
  /** Storefront path WITHOUT the market prefix. Omitted for the current page. */
  path?: string;
}

/**
 * A breadcrumb trail, matching the one on the page.
 *
 * THE VISIBLE TRAIL IS THE SPEC. Wovenne's breadcrumbs start at the section —
 * "Women / Sarees / Red Saree" — with no Home link in front of them, so this
 * emits three items and not four. Adding a Home level Google could not see on
 * the page would be inventing a step in the hierarchy, and the whole point of
 * this markup is to describe what is there.
 *
 * The last item carries no `item`: it is the page doing the describing, and
 * Google's guidance is that the final crumb may be left unlinked.
 */
export function breadcrumbNode(crumbs: Crumb[]) {
  if (crumbs.length === 0) return undefined;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: crumb.path ? customerUrl(cPath(crumb.path)) : undefined,
    })),
  };
}

/**
 * The business.
 *
 * OnlineStore, not Organization: Google names it as the subtype to use for an
 * ecommerce site, and it is the more specific truth.
 *
 * NAME, URL AND LOGO ONLY, and the omissions are the considered part.
 * Google lists no required properties and explicitly prefers a few accurate
 * ones over many. What is left out:
 *
 *   email      — the site currently publishes TWO. The footer says
 *                hello@thewovenne.com; clause 18 of the Terms says
 *                admin@thewovenne.com. Picking one here would make this file
 *                the tie-breaker on a business fact, which is not its job.
 *   telephone  — a WhatsApp number is published, but whether it is THE business
 *                telephone is a decision, not a lookup.
 *   address    — none is published anywhere. There is nothing to read.
 *   sameAs     — the Instagram profile is real, but it is admin-editable
 *                content, and it belongs with the contact reconciliation rather
 *                than ahead of it.
 *
 * `url` is the root, which is what Google uses to identify the entity — not
 * /in, which is one market inside the site.
 */
export function organizationNode() {
  return {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    name: BRAND_NAME,
    url: SITE_URL,
    logo: LOGO_URL,
  };
}

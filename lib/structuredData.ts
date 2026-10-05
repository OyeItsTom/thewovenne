import { customerUrl, PRODUCTION_ORIGIN, SITE_NAME } from "./seo";
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
 *   sku              — exists as its own stored column and is INTERNAL. The old
 *                      note here said it was "derived from the slug", which is
 *                      only how it is SEEDED: 0038's comment on the column is
 *                      explicit that it is independent afterwards, precisely so
 *                      that renaming a piece cannot silently repoint an import
 *                      matching on it. So "it just restates the URL" stopped
 *                      being the reason. The reason is that it is an operations
 *                      identifier — the admin product editor, the manual-order
 *                      picker, the CSV exports and the bulk importer — and no
 *                      page a customer opens shows it. PRODUCT_SELECT leaves it
 *                      out of the storefront query for that exact reason.
 *                      Structured data restates what the site says; an
 *                      identifier the storefront never says is not ours to
 *                      publish as product information
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

/** One spelling of the brand, shared with the metadata helpers. See lib/seo. */
export const BRAND_NAME = SITE_NAME;

/** The canonical entity URL: the site's own root, not a market inside it. */
export const SITE_URL = `${PRODUCTION_ORIGIN}/`;

/**
 * Stable identifiers for the two site-level entities, so the WebSite node can
 * name its publisher by reference instead of describing the business twice.
 *
 * Fragments on the ROOT, not on /in: the entities are the domain's, and /in is
 * one market inside it. They are identifiers rather than pages — nothing is
 * served at "#organization" — and they must never change once Google has seen
 * them, because a changed @id reads as a different entity.
 */
export const ORGANIZATION_ID = `${SITE_URL}#organization`;
export const WEBSITE_ID = `${SITE_URL}#website`;

/**
 * Other names people genuinely use for this site, most preferred first.
 *
 *   "Wovenne"         the short form the site itself uses — the assistant is
 *                     "Ask Wovenne" — and how the name is said aloud
 *   "thewovenne.com"  the domain, which is also how the brand is typed into a
 *                     search box (the Instagram handle is @thewovenne). Google's
 *                     site-name guidance names the domain as the fallback to
 *                     offer when the preferred name is not picked up
 *
 * NOT "The Wovenne": that is the same name in different case, not an
 * alternative, and listing it would only blur which casing is canonical.
 */
export const BRAND_ALTERNATE_NAMES = ["Wovenne", "thewovenne.com"] as const;

/**
 * The brand's own Instagram profile — the one identity outside this domain
 * that is verifiably Wovenne's.
 *
 * A CONSTANT HERE, NOT THE FOOTER'S ADMIN FIELD. The footer's Instagram row is
 * admin-editable content and can be retyped; an identity claim cannot follow a
 * text field. This is the profile the homepage's own Follow block links to
 * (components/home/InstagramGrid, which imports it from here) and the handle
 * printed on the logo artwork itself, and Google already lists it under the
 * brand name as "The Wovenne (@thewovenne)".
 *
 * Nothing else belongs beside it until it is confirmed: a YouTube channel
 * named @TheWovenne exists in search results, but whether it is the
 * business's is not something this codebase knows.
 */
export const OFFICIAL_INSTAGRAM_URL = "https://www.instagram.com/thewovenne";

/**
 * The logo, absolute.
 *
 * Google asks for at least 112x112, crawlable and indexable, and for an image
 * that looks as intended on a purely white background. This is the emblem on
 * white — 3096x2792, public, covered by robots.txt's Allow, and the same mark
 * the navbar, footer and favicon show.
 *
 * NOT logo_illustrated.png, which it used to be: that is the share flyer, with
 * "@thewovenne" and "www.thewovenne.com" printed under the wordmark. A logo is
 * the business's mark, not a promotional card, and Google crops logos small
 * enough that the printed handle and URL become noise. The flyer is still the
 * default share image (DEFAULT_OG_IMAGE in lib/seo), where that text belongs.
 */
export const LOGO_URL = customerUrl("/logo_emblem_white_bg.png");

/**
 * The business facts, confirmed by the owner and published on the site.
 *
 * EVERY ONE OF THESE IS ALSO VISIBLE TO A CUSTOMER — on the contact page, the
 * shipping page or the returns page. That is the test any value here has to
 * pass: structured data restates what the site says, and may not be the only
 * place a fact exists.
 *
 * hello@, NOT admin@. The site published both for a while — the footer's
 * mailto and clause 18 of the Terms disagreed. admin@ is the operator's own
 * login (migration 0008 promotes exactly that address), so it was never a
 * customer address; it is internal, and it stays internal.
 */
export const PUBLIC_EMAIL = "hello@thewovenne.com";
export const PUBLIC_PHONE = "+91 7736749305";

/** The registered trading address, as printed on the contact page. */
export const POSTAL_ADDRESS = {
  "@type": "PostalAddress",
  streetAddress: "Anns Building",
  addressLocality: "Kidangara",
  addressRegion: "Kerala",
  postalCode: "686102",
  addressCountry: "IN",
} as const;

/** The one market that can be bought from today. */
export const SHIPPING_COUNTRY = "IN";
/** Below this order value, delivery is charged. At or above it, it is free. */
export const FREE_SHIPPING_THRESHOLD_INR = 3000;
/**
 * The rest-of-India rate below the threshold, and Kerala's.
 *
 * Exported for the tests that hold the visible policy and the till together.
 * NEITHER is emitted as structured data — see shippingServiceNode for why
 * India's regional split cannot be stated to Google without contradicting one
 * group of customers or the other.
 */
export const STANDARD_SHIPPING_INR = 129;
export const KERALA_SHIPPING_INR = 99;

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
   * products.fabric, EXACTLY as stored — "Pure Cotton", "Handloom Cotton",
   * whatever the admin typed and the page prints. Null or absent for anything
   * with no fabric row, which is every piece of jewellery.
   */
  fabric?: string | null;
  /**
   * The labelled facts the page prints beside the price, from productFactRows()
   * in lib/productInfo — the SAME rows ProductDetail renders. Each becomes one
   * PropertyValue. The fabric row is left to `material` above rather than said
   * twice. Absent or empty: no additionalProperty at all.
   */
  facts?: { key: string; label: string; value: string }[];
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
 * DESCRIPTION IS THE PRODUCT'S OWN OR NOTHING. lib/metadata composes a
 * stand-in sentence for a product nobody has written up, which is right for a
 * META description — that tag summarises a PAGE — and wrong here, where
 * `description` is a statement about THIS piece. `input.description ?? undefined`
 * is load-bearing and must stay: a third of the catalogue would otherwise carry
 * a generated sentence as its own schema description. productMetaDescription()
 * states the same boundary from the other side, and neither function calls the
 * other.
 *
 * MATERIAL IS THE FABRIC ROW OR NOTHING, and it is the one property added since
 * SEO-3. It restates a value the product page already prints beside the price,
 * word for word — not a tidied, expanded or inferred version of it. It is NOT
 * read off a product's name: "Kochi Linen Shirt" with an empty fabric column
 * gets no material, because what that product is made of is not something this
 * codebase knows. Jewellery has no fabric and so has no material, rather than
 * being described as cloth.
 *
 * ADDITIONAL PROPERTIES ARE THE PAGE'S FACT ROWS OR NOTHING (0065). Weave,
 * finish, dimensions, blouse piece, fit and origin are written by the admin,
 * optional, and printed on the page; the markup restates exactly those rows.
 * Colour is still NOT marked up: the stored colour does not yet reliably
 * describe the cloth (most sarees read "Off-white" whatever their border), and
 * the page does not print it either.
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
    // Trimmed so a whitespace-only cell is absent rather than an empty string:
    // prune() would drop "" anyway, and saying so here makes it deliberate.
    material: input.fabric?.trim() || undefined,
    additionalProperty: factProperties(input.facts),
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
 * Stored facts as schema.org PropertyValues: weave, finish, dimensions, blouse
 * piece, fit, origin — whichever were written for this piece and are printed on
 * its page. Free text stays free text: "5.5 m × 1.15 m" is not parsed into a
 * QuantitativeValue it might misread, and an origin like "Chendamangalam,
 * Kerala" is not promoted to countryOfOrigin, which wants a country it would
 * have to infer. Undefined when there is nothing, so prune() drops the key.
 */
function factProperties(facts: ProductNodeInput["facts"]) {
  const rows = (facts ?? []).filter((f) => f.key !== "fabric" && f.value.trim());
  if (rows.length === 0) return undefined;
  return rows.map((f) => ({ "@type": "PropertyValue", name: f.label, value: f.value.trim() }));
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
 * What happens to a parcel, as schema can HONESTLY express it — which is less
 * than the policy says, and deliberately so.
 *
 * ── THE POLICY ──
 *
 *   below ₹3,000   ₹99 within Kerala, ₹129 elsewhere in India
 *   ₹3,000 and up  free, anywhere in India
 *
 * ── WHY ONLY THE SECOND LINE IS HERE ──
 *
 * Google resolves a shipping destination through DefinedRegion, which narrows
 * below a country by addressRegion or postalCode — and both are limited to a
 * handful of countries. addressRegion is supported for the US, Australia and
 * Japan; postalCode for Australia, Canada and the US. India is on neither list,
 * and postalCodePrefix is not a property Google reads at all.
 *
 * So "₹99 in Kerala" has no faithful encoding. The three ways to force it are
 * all worse than silence:
 *
 *   ₹129 nationwide — true for most of India, and ₹30 more than a Kerala
 *                     customer is charged. Over-quoting is the safer direction,
 *                     but it still publishes a number the checkout contradicts.
 *   ₹99 nationwide  — under-quotes almost every order. A customer told ₹99 and
 *                     charged ₹129 is the failure this whole file exists to
 *                     prevent.
 *   invented region — markup Google does not read, describing a boundary it
 *                     cannot resolve.
 *
 * The free tier has none of that trouble: at ₹3,000 and above delivery is free
 * everywhere in India, with no regional distinction to lose. It is stated here
 * because it is true for every order, everywhere, without qualification.
 *
 * Below the threshold, NOTHING is claimed. The shipping page carries the real
 * rates and the checkout charges them; an absent rate sends a reader to the
 * page, while a wrong one sends them to the wrong number.
 *
 * NO handlingTime OR transitTime either: the policy is written in BUSINESS
 * days, and ServicePeriod expresses that as a day count plus the businessDays
 * it counts in. Which days those are for Wovenne is not a confirmed fact, and a
 * bare day count reads as calendar days — promising faster delivery than the
 * page does.
 */
function shippingServiceNode() {
  return {
    "@type": "ShippingService",
    name: "Free delivery within India on orders of ₹3,000 or more",
    shippingConditions: [
      {
        "@type": "ShippingConditions",
        shippingDestination: [
          { "@type": "DefinedRegion", addressCountry: SHIPPING_COUNTRY },
        ],
        orderValue: {
          "@type": "MonetaryAmount",
          minValue: FREE_SHIPPING_THRESHOLD_INR,
          currency: "INR",
        },
        shippingRate: { "@type": "MonetaryAmount", value: 0, currency: "INR" },
      },
    ],
  };
}

/**
 * The return policy, in the only three categories Google accepts.
 *
 * MerchantReturnNotPermitted, because the shop does not take returns for
 * change of mind — and that category needs only applicableCountry. It must NOT
 * become MerchantReturnFiniteReturnWindow with 7 days: the seven days in the
 * policy are the window for REPORTING a damaged, incorrect or wrongly-sized
 * item, not a window in which anything may be sent back for any reason.
 * Encoding it as a return window would advertise a change-of-mind policy the
 * shop does not offer, to customers who would then be refused.
 *
 * The remedies that do exist for damaged, defective or incorrect goods are on
 * the returns page, which merchantReturnLink points at. Google's taxonomy has
 * no category for "no returns except faulty", and the honest choice between
 * what it does offer is this one.
 */
function returnPolicyNode() {
  return {
    "@type": "MerchantReturnPolicy",
    applicableCountry: SHIPPING_COUNTRY,
    returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
    // THE SLUG THE PAGE ACTUALLY PUBLISHED UNDER. The admin titled it
    // "Returns & Exchanges" and the CMS slugged it from the title, so the live
    // URL is /in/returns-exchanges — not the /in/returns this was first written
    // against. A merchantReturnLink is a promise that a policy is readable at
    // that address; pointing it at a 404 would be worse than omitting it.
    merchantReturnLink: customerUrl(cPath("/returns-exchanges")),
  };
}

/**
 * The business.
 *
 * OnlineStore, not Organization: Google names it as the subtype to use for an
 * ecommerce site, and it is the more specific truth.
 *
 * NOW CARRYING CONTACT DETAILS, which it could not before. The site used to
 * publish two email addresses and this file refused to pick between them —
 * correctly, because that was a business decision and not a rendering one. It
 * has been settled: hello@ is the customer address, admin@ is the operator's
 * own login and stays off the storefront.
 *
 * sameAs IS THE INSTAGRAM PROFILE AND NOTHING ELSE — see OFFICIAL_INSTAGRAM_URL
 * for why that is a fixed constant rather than the footer's editable field.
 *
 * Still deliberately absent: description (the business is described by the
 * page and by the WebSite node's own page; a schema sentence would be a second
 * place for a claim to drift), legalName, foundingDate, taxID and any
 * registration number — none of them is a confirmed fact in this codebase.
 *
 * `url` is the root, which is what Google uses to identify the entity — not
 * /in, which is one market inside the site.
 */
export function organizationNode() {
  return {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    "@id": ORGANIZATION_ID,
    name: BRAND_NAME,
    alternateName: [BRAND_ALTERNATE_NAMES[0]],
    url: SITE_URL,
    logo: LOGO_URL,
    sameAs: [OFFICIAL_INSTAGRAM_URL],
    email: PUBLIC_EMAIL,
    telephone: PUBLIC_PHONE,
    address: POSTAL_ADDRESS,
    hasMerchantReturnPolicy: returnPolicyNode(),
    hasShippingService: shippingServiceNode(),
  };
}

/**
 * The site itself — the node Google's site-name system reads.
 *
 * ── WHY THIS LIVES ON /in ──
 *
 * Google wants WebSite markup on the domain-level home page, and "/" on this
 * domain is a single permanent redirect to /in (middleware). A redirect has no
 * HTML to carry markup, and Google's site-name documentation is explicit that
 * when the home page redirects, "the site name will reflect the redirect
 * target". So /in — the page "/" resolves to, and the page whose canonical is
 * itself — is where the node has to be.
 *
 * `url` IS STILL THE ROOT: the property names the home page of the domain, and
 * the site being named is www.thewovenne.com, not a /in subdirectory (Google
 * does not support site names below the domain or subdomain level at all).
 *
 * ONE WebSite NODE, NOT TWO. Google asks that site-name properties sit on a
 * single WebSite node rather than a second block. Nothing else on the site
 * emits one; scripts/seo-structured-data.test.ts holds that.
 *
 * No SearchAction: the sitelinks search box it powered was retired by Google in
 * November 2024, and the site's search page is not something to advertise as a
 * feature that no longer exists.
 */
export function websiteNode() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: BRAND_NAME,
    alternateName: [...BRAND_ALTERNATE_NAMES],
    url: SITE_URL,
    publisher: { "@id": ORGANIZATION_ID },
  };
}

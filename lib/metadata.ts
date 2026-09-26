import { SITE_NAME } from "./seo";

/**
 * The words a page puts in front of a customer before they have opened it.
 *
 * NO REACT, NO NEXT, NO DATABASE — the same rule lib/sitemapRoutes and
 * lib/structuredData are held to, and for the same reason. Every sentence built
 * here is a CLAIM made on the shop's behalf in a search result, and a claim
 * that needs a running site to check is a claim nobody checks.
 *
 * ── THE RULE THAT SHAPES EVERY FUNCTION BELOW ──
 *
 * Nothing is invented. The catalogue this ships against is mostly handloom
 * cotton sarees plus some jewellery; documented provenance is mixed, a few
 * pieces trace to West Bengal, and most rows store no origin at all. So no
 * function here may say "linen", "woven in Kerala" or "for the UK" — three
 * claims the storefront made generically until now, none of which the catalogue
 * supports. Where an origin genuinely helps, it is INDIA, which is true of the
 * whole catalogue.
 *
 * Material, origin, weave, occasion and colour are facts about a PIECE. They
 * appear here only where a stored field holds them, and are absent otherwise —
 * never guessed from a product's name.
 */

/** Google truncates around here; longer costs nothing but says nothing either. */
export const META_DESCRIPTION_MAX = 155;

/**
 * Prose as a meta description: one line, whole words, no mid-word cut.
 *
 * Product descriptions and journal bodies are written as paragraphs, with
 * newlines and runs of spaces in them. A raw `.slice(0, 155)` — which is what
 * both the product routes and the journal route did — puts those paragraph
 * breaks straight into the tag and, roughly four times in five, ends on half a
 * word. This collapses the whitespace first and then cuts at the last space
 * before the limit.
 *
 * A single word longer than the limit has no space to cut at, and is cut hard
 * rather than returned over-length: that shape is a slug or a URL, not a
 * sentence, and neither reads better whole.
 *
 * Returns undefined for nothing at all, so a caller can hand the result
 * straight to `description` and have the key simply not appear.
 */
export function metaDescription(
  text: string | null | undefined,
  max: number = META_DESCRIPTION_MAX
): string | undefined {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= max) return collapsed;

  // max + 1, so a space landing exactly on the boundary is found and the
  // sentence keeps its last whole word.
  const window = collapsed.slice(0, max + 1);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : collapsed.slice(0, max);
  // Trailing punctuation left dangling by the cut reads as a typo next to the
  // ellipsis — "cotton, …" rather than "cotton…".
  return `${cut.replace(/[\s,;:–—-]+$/, "")}…`;
}

/**
 * Parent sections whose name is an AUDIENCE rather than a kind of thing.
 *
 * WHY A LIST AND NOT A COLUMN. "Is this word a group of people?" is a fact
 * about English, not about the catalogue — there is nothing in the database to
 * read it from, and adding a column would ask an admin to answer a grammar
 * question every time they make a category. The list is matched on the SLUG,
 * which is stable, and it exists to stop one sentence shape being built:
 *
 *   Women → Sarees   →  "Sarees for Women"     ✓ an audience takes "for"
 *   Jewellery → Rings →  "Rings for Jewellery"  ✗ a category does not
 *
 * A section not listed here is simply treated as a kind of thing, which is the
 * safe direction: the worst case is a slightly plainer title, not a wrong one.
 */
const AUDIENCE_SLUGS = new Set([
  "women",
  "men",
  "kids",
  "children",
  "girls",
  "boys",
  "baby",
  "unisex",
]);

export function isAudienceCategory(slug: string): boolean {
  return AUDIENCE_SLUGS.has(slug.trim().toLowerCase());
}

/** "Sarees", "Sarees and Dhotis", "Sarees, Dhotis and Rings". */
function listPhrase(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Enough to be useful, short enough to leave room for the rest of the sentence.
 * Beyond this the list stops naming and starts listing.
 */
const MAX_NAMED_CHILDREN = 4;

function namedChildren(children: string[]): string {
  if (children.length === 0) return "";
  if (children.length <= MAX_NAMED_CHILDREN) return listPhrase(children);
  return `${listPhrase(children.slice(0, MAX_NAMED_CHILDREN))} and more`;
}

/**
 * The one line every category description ends on.
 *
 * India, not Kerala — see the header. It is also the only shipping claim made
 * here, and it is true without qualification: the storefront sells into India
 * and nowhere else, whatever the rate turns out to be. See lib/structuredData
 * for why the RATES cannot be stated the same way.
 */
const CLOSING = "Shipped across India.";

/**
 * The same clause where it follows a comma rather than a full stop.
 *
 * DERIVED, NOT RETYPED. Written out a second time it drifted immediately: the
 * first version of this called `CLOSING.toLowerCase()`, which also lowercased
 * India and put "shipped across india." on every product page in the catalogue
 * without a description — 26 of 33 pieces. Only the first character may change
 * case, so the country cannot.
 */
const CLOSING_CONTINUED = CLOSING.charAt(0).toLowerCase() + CLOSING.slice(1);

export interface CategoryMetaInput {
  /** The section, e.g. { slug: "women", name: "Women" }. */
  parent: { slug: string; name: string };
  /** The sub-category, when this is a sub-category page. */
  child?: { slug: string; name: string } | null;
  /**
   * The names of the sub-categories under this parent that actually hold a
   * product. Used only for a parent page's description, so it names what is
   * there instead of a template. Empty is a real answer — see emptiness below.
   */
  stockedChildren?: string[];
}

/**
 * A category page's title.
 *
 * A PARENT IS JUST ITS OWN NAME. "Women | THE WOVENNE", "Jewellery | THE
 * WOVENNE" — there is nothing to add that the name does not already say.
 *
 * A CHILD DEPENDS ON WHAT ITS PARENT IS. Under an audience the relationship is
 * "for": Sarees for Women. Under a category it is containment, and "for" turns
 * it into nonsense — "Rings for Jewellery" — so the child stands on its own.
 */
export function categoryTitle({ parent, child }: CategoryMetaInput): string {
  if (!child) return `${parent.name} | ${SITE_NAME}`;
  return isAudienceCategory(parent.slug)
    ? `${child.name} for ${parent.name} | ${SITE_NAME}`
    : `${child.name} | ${SITE_NAME}`;
}

/**
 * A category page's description, from what the category IS and what it holds.
 *
 * NO MATERIAL, NO ORIGIN, NO PRODUCT KINDS THAT ARE NOT THERE. The template
 * this replaces said "Handloom linen for women — woven in Kerala, sent direct
 * from the loom" on every section of the site, including the jewellery one,
 * and every word of it after "Handloom" was either unsupported or wrong.
 *
 * A parent NAMES ITS STOCKED SUB-CATEGORIES, which is both the most useful
 * thing it can say and the only thing it can say that is checkable: the list
 * comes from the catalogue read the page itself renders from.
 */
export function categoryDescription({
  parent,
  child,
  stockedChildren = [],
}: CategoryMetaInput): string {
  if (child) {
    return isAudienceCategory(parent.slug)
      ? `${child.name} for ${parent.name.toLowerCase()}, from ${SITE_NAME}. ${CLOSING}`
      : `${child.name} from ${SITE_NAME}'s ${parent.name.toLowerCase()} collection. ${CLOSING}`;
  }

  const named = namedChildren(stockedChildren);
  // Nothing stocked: say what the section is and stop. The page is noindex
  // while it is in this state anyway — see the route — so this sentence is for
  // the handful of people who arrive from a link, not for a search result.
  if (!named) return `${parent.name} from ${SITE_NAME}. ${CLOSING}`;

  /*
   * "Shop …", WHICH IS NOT DECORATION. A section with exactly one stocked child
   * would otherwise describe itself in the child's own words: /in/men and
   * /in/men/dhotis both read "Dhoti for men, from THE WOVENNE." — two indexable
   * URLs with byte-identical descriptions, which is a duplicate signal invented
   * by the very change meant to remove them. Today men and jewellery are both in
   * that shape.
   *
   * The lead also happens to be the more accurate verb for a section page: it
   * lists what is under it, while the child page IS the thing.
   */
  return isAudienceCategory(parent.slug)
    ? `Shop ${named} for ${parent.name.toLowerCase()} at ${SITE_NAME}. ${CLOSING}`
    : `Shop ${named} at ${SITE_NAME}. ${CLOSING}`;
}

/**
 * Does the product's own name already say what kind of thing it is?
 *
 * "Kasavu Saree" under Sarees does, and repeating it gives "Kasavu Saree —
 * Sarees", which reads like a database row. Matched against the plural as
 * stored AND the bare singular, because categories are named in the plural and
 * products almost never are. The trailing "s" is the only inflection handled:
 * guessing further would start inventing words.
 */
function nameAlreadySays(name: string, category: string): boolean {
  const lower = name.toLowerCase();
  const cat = category.trim().toLowerCase();
  if (!cat) return false;
  if (lower.includes(cat)) return true;
  const singular = cat.replace(/(?:es|s)$/, "");
  return singular.length > 2 && lower.includes(singular);
}

export interface ProductMetaInput {
  name: string;
  /** products.description. Null or blank when nobody has written one. */
  description: string | null | undefined;
  /** The sub-category the product is filed under, e.g. "Sarees". */
  categoryName?: string | null;
  /** products.fabric, exactly as stored. Null for jewellery and anything else. */
  fabric?: string | null;
}

/**
 * A product page's meta description — the real one, or an honest stand-in.
 *
 * ── THIS IS METADATA ONLY, AND THAT BOUNDARY IS LEAD-LINED ──
 *
 * A meta description is a summary of a PAGE and may fall back to what the shop
 * can say about a piece it has not written up. `description` in the Product
 * node is a statement about the PIECE, and may not. productNode() therefore
 * still takes `product.description ?? undefined` and must keep taking it: a
 * third of the catalogue would otherwise carry a composed sentence as its own
 * schema description. See lib/structuredData, which states the same rule from
 * the other side.
 *
 * ── WHAT THE STAND-IN MAY USE ──
 *
 * Only values already on the page in front of the customer: the product's name,
 * the fabric row when there is one, and the sub-category it is filed under.
 * No colour — the field exists but reads as a marketing word as often as a
 * fact. No origin, no weave, no border, no occasion, no blouse piece, no care
 * and no dimensions: none of those are stored, so none of those get said.
 *
 * Jewellery has no fabric and so simply gets a shorter sentence, rather than
 * being called cloth.
 */
export function productMetaDescription(input: ProductMetaInput): string | undefined {
  const written = metaDescription(input.description);
  if (written) return written;

  const facts: string[] = [];
  const fabric = input.fabric?.trim();
  if (fabric) facts.push(fabric);
  const category = input.categoryName?.trim();
  if (category && !nameAlreadySays(input.name, category)) facts.push(category);

  const lead = facts.length > 0
    ? `${input.name} — ${facts.join(", ")}.`
    : `${input.name}.`;
  return metaDescription(`${lead} From ${SITE_NAME}, ${CLOSING_CONTINUED}`);
}

/**
 * Whether a category page may be indexed, from how much is filed under it.
 *
 * ── THE PROBLEM ──
 *
 * TEN of the fourteen visible sub-categories hold nothing — men/shirts, kurtas,
 * trousers and nehru-jackets; women/dresses, kurtis, blouses and sets;
 * jewellery/chain and earrings, against a live catalogue of 33 pieces filed
 * almost entirely under women/sarees. Their pages render "This collection is
 * still on the loom", which is the right thing to show a person who follows a
 * link and the wrong thing to submit to a search engine.
 *
 * That count is written here as an observation and is stored NOWHERE. It will be
 * wrong the week a section is stocked, and nothing breaks when it is. Google
 * answers an indexed empty page with "Crawled – currently not indexed", and
 * enough of those shape how the whole property is judged — the argument
 * lib/sitemapRoutes already makes about which URLs are worth submitting.
 *
 * ── noindex, BUT follow ──
 *
 * `follow`, deliberately. The section architecture is not the problem and is
 * not being removed: those pages link into the nav, the parent and each other,
 * and a crawler that stops following them loses paths to pages that ARE worth
 * indexing. "Do not list this" is the claim; "ignore everything it points at"
 * is not.
 *
 * ── AND IT IS A STATE, NOT A DECISION ──
 *
 * Returning undefined rather than `{ index: true }` for a stocked category is
 * the point: the page goes back to being indexable the moment a product is
 * filed under it, with no list to update and no deploy. The one condition is
 * the count, and it comes from the same catalogue read the sitemap and the
 * navigation use.
 *
 * SITEMAP AGREEMENT IS NOT COINCIDENTAL. buildSitemap() already drops a
 * sub-category with no stocked product and a parent with no stocked child. This
 * is the same rule, said in the head of the page rather than in the file, so
 * the two cannot contradict each other.
 */
export function emptyCategoryRobots(
  stocked: readonly unknown[] | null
): { index: false; follow: true } | undefined {
  // null is "could not tell", and it is NOT "empty". See stockedChildrenOf.
  if (stocked === null) return undefined;
  return stocked.length > 0 ? undefined : { index: false, follow: true };
}

/** The shape stockedChildrenOf needs, and nothing more. */
export interface NavSection {
  slug: string;
  children: { slug: string; name: string }[];
}

/**
 * Which sub-categories of one section hold a product — or NULL for "the
 * catalogue could not be read".
 *
 * ── WHY THE THIRD ANSWER EXISTS ──
 *
 * getNavCategoryTree() FAILS CLOSED: when its product query errors it logs and
 * returns an empty tree, so that a section is never advertised in the header on
 * the strength of a read nobody could complete. That is the right instinct for a
 * navigation bar and the wrong one for a robots tag, because the two failures
 * are not symmetric. A section missing from the nav for sixty seconds costs a
 * few clicks. A stocked category page that emits `noindex` during one ISR
 * regeneration, and is crawled in that window, can be dropped from the index —
 * and the page will not say otherwise until something regenerates it again.
 *
 * So emptiness has to be something the catalogue SAID, not something left over
 * when it said nothing. An empty tree is the one shape that cannot be
 * distinguished from a failed read, and it is reported as unknown; the caller
 * then asserts nothing and the page keeps whatever the site default is.
 *
 * The cost of that choice is precise and small: on a storefront that genuinely
 * has no stock at all, the empty sections stay indexable. There is nothing to
 * sell on that site anyway.
 *
 * A section absent from a NON-empty tree is a real, readable answer — that is
 * exactly what "visible, and holding nothing" looks like — and comes back [].
 */
export function stockedChildrenOf(
  nav: NavSection[],
  parentSlug: string
): { slug: string; name: string }[] | null {
  if (nav.length === 0) return null;
  return nav.find((section) => section.slug === parentSlug)?.children ?? [];
}

/**
 * The same answer, narrowed to ONE sub-category, for its own page.
 *
 * Matched on the SLUG, not the name: a name is an admin's free text and can be
 * edited or duplicated, while the slug is what the URL is built from and what
 * this page is. "Could not tell" survives the narrowing unchanged — it has to,
 * or the distinction stockedChildrenOf draws would be thrown away one line
 * after it was made.
 */
export function stockedSelf(
  stocked: { slug: string; name: string }[] | null,
  childSlug: string
): { slug: string; name: string }[] | null {
  if (stocked === null) return null;
  return stocked.filter((child) => child.slug === childSlug);
}

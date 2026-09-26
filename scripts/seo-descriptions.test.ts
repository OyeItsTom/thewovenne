/**
 * What a product page and a journal post say about themselves in a snippet.
 *
 *   npx tsx scripts/seo-descriptions.test.ts
 *
 * Exits non-zero on failure.
 *
 * SEPARATE FROM seo-metadata BY BEHAVIOUR, not by size. That suite holds the
 * storefront's GENERIC claims — the site-wide fallbacks and the category
 * templates, where the sentence is composed from a route's identity. This one
 * holds the composition of a description from ONE ROW: a product's own prose,
 * its fabric and its filing; a journal post's own body.
 *
 * ── THE DEFECTS THESE ASSERTIONS EXIST FOR ──
 *
 * 1. `product.description?.slice(0, 155)` and `post.body?.slice(0, 155)`. Both
 *    bodies are written as paragraphs, so the raw slice put the blank lines
 *    between them into the tag, and it ended mid-word far more often than not.
 *
 * 2. `?? "Authentic handloom linen from Kerala."` on both product routes. 26 of
 *    the 33 live products have no written description, so that one sentence was
 *    the meta description of four fifths of the catalogue — including a copper
 *    choker and a 14K-plated ring.
 *
 * 3. THE BOUNDARY, which is the one worth guarding hardest: the composed
 *    fallback is a summary of a PAGE and must never reach `description` in the
 *    Product node, which is a statement about a PIECE. The two live one import
 *    apart and neither may borrow the other's default.
 */
import fs from "node:fs";
import { metaDescription, productMetaDescription } from "../lib/metadata";
import { productNode } from "../lib/structuredData";
import { SITE_NAME } from "../lib/seo";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note && ok ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

function ok(name: string, condition: boolean, note?: string) {
  check(name, condition, true, note);
}

console.log("\n=== PDP FALLBACK: composed from what the page already shows ===");

check(
  "a written description wins outright",
  productMetaDescription({
    name: "Kasavu Saree",
    description: "A handloom pure cotton saree in classic ivory.",
    categoryName: "Sarees",
    fabric: "Handloom Cotton",
  }),
  "A handloom pure cotton saree in classic ivory."
);
check(
  "a written description is cleaned on the way through",
  productMetaDescription({
    name: "Kasavu Saree",
    description: "  A handloom saree.\n\n  In ivory.  ",
    categoryName: "Sarees",
    fabric: "Handloom Cotton",
  }),
  "A handloom saree. In ivory."
);
check(
  "a blank description counts as none",
  productMetaDescription({ name: "Kasavu Saree", description: "   \n ", fabric: "Cotton" }),
  `Kasavu Saree — Cotton. From ${SITE_NAME}, shipped across India.`
);
check(
  "name plus fabric, with the category dropped because the name already says it",
  productMetaDescription({
    name: "Kasavu Saree",
    description: null,
    categoryName: "Sarees",
    fabric: "Handloom Cotton",
  }),
  `Kasavu Saree — Handloom Cotton. From ${SITE_NAME}, shipped across India.`
);
check(
  "the category is kept when the name does not say it",
  productMetaDescription({
    name: "Ivory Drape",
    description: null,
    categoryName: "Sarees",
    fabric: "Cotton",
  }),
  `Ivory Drape — Cotton, Sarees. From ${SITE_NAME}, shipped across India.`
);
check(
  "jewellery gets a shorter sentence rather than a fabric",
  productMetaDescription({
    name: "Copper Necklace",
    description: null,
    categoryName: "Necklaces",
    fabric: null,
  }),
  `Copper Necklace. From ${SITE_NAME}, shipped across India.`
);
check(
  "jewellery whose name does not say its kind keeps the category",
  productMetaDescription({
    name: "Aurum Band",
    description: null,
    categoryName: "Rings",
    fabric: null,
  }),
  `Aurum Band — Rings. From ${SITE_NAME}, shipped across India.`
);
check(
  "a product with nothing filed still gets a sentence",
  productMetaDescription({ name: "Unfiled Piece", description: null }),
  `Unfiled Piece. From ${SITE_NAME}, shipped across India.`
);
check(
  "a whitespace-only fabric is not a fabric",
  productMetaDescription({ name: "Aurum Band", description: null, fabric: "   " }),
  `Aurum Band. From ${SITE_NAME}, shipped across India.`
);

const composed = [
  productMetaDescription({ name: "Kasavu Saree", description: null, categoryName: "Sarees", fabric: "Handloom Cotton" })!,
  productMetaDescription({ name: "Copper Necklace", description: null, categoryName: "Necklaces" })!,
];
for (const invented of ["kerala", "linen", "west bengal", "blouse", "border", "wedding", "ivory", "occasion"]) {
  check(`the fallback invents no "${invented}"`, composed.filter((c) => c.toLowerCase().includes(invented)), []);
}

console.log("\n=== THE FALLBACK STOPS AT THE TAG: schema never inherits it ===");

/**
 * NO `fabric` ON THIS FIXTURE, on purpose. What is being asserted is that the
 * node's `description` stays absent, and that holds whether or not a material
 * is being emitted beside it — so the fixture is kept to the properties the
 * claim actually depends on. lib/structuredData's own suite owns the material
 * rule, and this stays readable without it.
 */
const FABRIC = "Handloom Cotton";
const unwritten = {
  name: "Kasavu Saree",
  href: "/in/women/sarees/kasavu-saree",
  images: ["https://example.test/a.jpg"],
  description: null,
  price: 4200,
  soldOut: false,
  rating: { average: null, total: 0 },
};
const schema = productNode(unwritten);
const fallback = productMetaDescription({
  name: unwritten.name,
  description: null,
  categoryName: "Sarees",
  fabric: FABRIC,
})!;

check("the Product node has no description", schema.description, undefined);
ok(
  "and the composed meta sentence appears nowhere in it",
  !JSON.stringify(schema).includes(fallback),
  "a meta description summarises a page; a schema description states a fact about a piece"
);
ok(
  "not even a fragment of it",
  !JSON.stringify(schema).includes(`From ${SITE_NAME}, shipped`)
);
check("while the meta description is present", typeof fallback, "string");

console.log("\n=== JOURNAL: a body becomes one clean line ===");

/**
 * The shape a real post is stored in — paragraphs separated by blank lines,
 * which is what the editor produces and what the raw slice used to leak.
 */
const POST_BODY = [
  "Linen is the oldest woven fibre known to us.",
  "",
  "It breathes, it lasts, and it asks little of the land.  This is why every",
  "WOVENNE piece begins with flax, and why the cloth outlives the season it was",
  "bought in.",
].join("\n");

const journalMeta = metaDescription(POST_BODY)!;

ok("the paragraph breaks are gone", !/[\r\n]/.test(journalMeta));
ok("and so are the double spaces", !journalMeta.includes("  "));
ok("it is truncated", journalMeta.length < POST_BODY.length);
ok("on a word boundary, with an ellipsis", journalMeta.endsWith("…"));
ok(
  "every kept word is a whole word of the article",
  journalMeta
    .slice(0, -1)
    .split(" ")
    .every((word) => POST_BODY.split(/\s+/).includes(word))
);
check(
  "the article body itself is never rewritten — this only reads it",
  POST_BODY.includes("\n\n"),
  true,
  "the fixture is unchanged by having been summarised"
);
check("a post with no body gets no description at all", metaDescription(null), undefined);
check("nor one whose body is only whitespace", metaDescription("\n\n  \t "), undefined);

// ── Source guards ─────────────────────────────

const read = (p: string) => fs.readFileSync(p, "utf8");

/**
 * Comments stripped, string literals kept — the same scanner seo-metadata uses,
 * and necessary for the same reason: these routes now EXPLAIN the claim they
 * used to make, and a plain text search would read the explanation as the
 * defect.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | '"' | "'" | "`" = "code";
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (mode === "code") {
      if (two === "//") { mode = "line"; i += 2; continue; }
      if (two === "/*") { mode = "block"; i += 2; continue; }
      if (src[i] === '"' || src[i] === "'" || src[i] === "`") mode = src[i] as '"' | "'" | "`";
      out += src[i++];
      continue;
    }
    if (mode === "line") {
      if (src[i] === "\n") { mode = "code"; out += "\n"; }
      i++;
      continue;
    }
    if (mode === "block") {
      if (two === "*/") { mode = "code"; i += 2; } else i++;
      continue;
    }
    if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (src[i] === mode) mode = "code";
    out += src[i++];
  }
  return out;
}

/**
 * Comments gone, and the one use of "linen" that is not a claim gone with them:
 * `bg-linen` is the PALETTE COLOUR (--color-linen, #f0ead6), a cream named after
 * a fibre, on a background utility. The journal post route wraps its hero image
 * in one. Renaming the token is a design decision and not this suite's business.
 */
const prose = (src: string) =>
  stripComments(src)
    .toLowerCase()
    .replace(/\b(?:bg|text|border|from|to|via|ring|fill|stroke)-linen(?:\/\d+)?\b/g, " ");

/** The four routes whose descriptions are composed from one row. */
const ROW_ROUTES = [
  "app/(storefront)/in/[slug]/[child]/[product]/page.tsx",
  "app/(storefront)/in/product/[slug]/page.tsx",
  "app/(storefront)/in/journal/page.tsx",
  "app/(storefront)/in/journal/[slug]/page.tsx",
];

console.log("\n=== SOURCE GUARDS: no canned claim survives on these routes ===");

for (const { word, why } of [
  { word: "linen", why: "no linen is stocked" },
  { word: "kerala", why: "provenance is mixed and mostly unrecorded" },
  { word: "the uk", why: "the storefront is India-only" },
] as const) {
  // The journal INDEX is excluded, and deliberately: its description is about
  // the articles and matches the standfirst printed on the page itself.
  // Editorial copy was out of scope, and a tag disagreeing with the page under
  // it would be a different defect from the one being fixed here.
  const swept = ROW_ROUTES.filter((f) => !f.endsWith("journal/page.tsx"));
  const offenders = swept
    .filter((f) => prose(read(f)).includes(word))
    .map((f) => f.replace("app/(storefront)/", ""));
  check(`no live "${word}" on the product routes`, offenders, [], why);
}

ok(
  "the stripper is working — the removed claim IS still in the comments",
  read(ROW_ROUTES[0]).toLowerCase().includes("linen"),
  "if this fails, the sweep above is passing for the wrong reason"
);

console.log("\n=== SOURCE GUARDS: the helpers are used, the slices are gone ===");

const hierarchical = stripComments(read(ROW_ROUTES[0]));
const legacy = stripComments(read(ROW_ROUTES[1]));
const journalPost = stripComments(read(ROW_ROUTES[3]));

for (const [name, src] of [["hierarchical", hierarchical], ["legacy flat", legacy]] as const) {
  ok(`the ${name} product route composes its description`, src.includes("productMetaDescription("));
  ok(`and no longer slices it by hand`, !/description\?\.slice\(/.test(src));
}
ok("the journal post route collapses its body", journalPost.includes("metaDescription(post.body)"));
ok("and no longer slices it by hand", !/body\?\.slice\(/.test(journalPost));

console.log("\n=== SOURCE GUARDS: Open Graph on these routes ===");

for (const file of ROW_ROUTES) {
  const src = stripComments(read(file));
  ok(
    `${file.replace("app/(storefront)/", "")} builds its openGraph`,
    /openGraph:\s*openGraph\(/.test(src) && !/openGraph:\s*\{/.test(src),
    "an object literal silently drops siteName, type and the image"
  );
}
ok(
  "a journal post is typed as an article",
  /type:\s*"article"/.test(journalPost),
  "the one route on the site where Next's OpenGraph union has the true type"
);
ok(
  "neither product route claims an openGraph product type",
  !hierarchical.includes('"product"') && !legacy.includes('"product"'),
  "Next 14.2.5 throws Invalid OpenGraph type on it — verified in its generator"
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

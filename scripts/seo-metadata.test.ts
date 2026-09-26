/**
 * What the storefront says about itself before anyone opens it.
 *
 *   npx tsx scripts/seo-metadata.test.ts
 *
 * Exits non-zero on failure.
 *
 * THREE KINDS OF CHECK LIVE HERE, labelled apart.
 *
 * TRUTHFULNESS — the rule this suite exists for. The site shipped for months
 * telling Google it sold "authentic handloom Indian linen ... for the UK",
 * "woven in Kerala", on a storefront whose catalogue is mostly handloom cotton
 * and which sells into India and nowhere else. It was on the root layout, the
 * shop, both category templates, the collection route, Worn by You and every
 * product without a written description — including a copper necklace. Nothing
 * in a type or a build notices a sentence that is merely false.
 *
 * BEHAVIOUR — the builders in lib/metadata and lib/seo, exercised directly.
 *
 * SOURCE GUARDS — assertions about the text of the route files, for the two
 * defects that cannot be caught any other way: a false claim written back into
 * a literal, and an `openGraph: { ... }` object literal, which Next accepts
 * happily and which silently drops siteName, type and the share image.
 *
 * ── THE ONE THING THIS SUITE DELIBERATELY DOES NOT DO ──
 *
 * It does not forbid the word "linen" everywhere. It forbids it in the GENERIC
 * paths — the site-wide fallbacks, the category templates, the composed product
 * fallback. If a linen piece is ever stocked, its own description, its own
 * fabric row and its own journal article may all say so, and every one of those
 * flows through a path this suite leaves alone. A test that blocked the word
 * outright would have to be deleted to sell the product.
 */
import fs from "node:fs";
import {
  categoryDescription,
  categoryTitle,
  emptyCategoryRobots,
  isAudienceCategory,
  metaDescription,
  META_DESCRIPTION_MAX,
  productMetaDescription,
  stockedChildrenOf,
  stockedSelf,
} from "../lib/metadata";
import { openGraph, DEFAULT_OG_IMAGE, SITE_NAME } from "../lib/seo";
import { cPath } from "../lib/country";

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

const ORIGIN = "https://www.thewovenne.com";

// ── Fixtures ──────────────────────────────────
// The real shape of the tree: two audience sections and one that is a kind of
// thing, which is the distinction the titles turn on.

const WOMEN = { slug: "women", name: "Women" };
const MEN = { slug: "men", name: "Men" };
const JEWELLERY = { slug: "jewellery", name: "Jewellery" };
const SAREES = { slug: "sarees", name: "Sarees" };
const DHOTIS = { slug: "dhotis", name: "Dhotis" };
const RINGS = { slug: "rings", name: "Rings" };
const NECKLACES = { slug: "necklaces", name: "Necklaces" };

/**
 * Every sentence the generic paths can produce, for the truthfulness sweep.
 *
 * Built from the builders rather than written out, so a change to any template
 * is swept automatically instead of quietly escaping a fixed list.
 */
const GENERIC_COPY: string[] = [
  categoryTitle({ parent: WOMEN }),
  categoryTitle({ parent: JEWELLERY }),
  categoryTitle({ parent: WOMEN, child: SAREES }),
  categoryTitle({ parent: JEWELLERY, child: RINGS }),
  categoryDescription({ parent: WOMEN, stockedChildren: ["Sarees"] }),
  categoryDescription({ parent: MEN, stockedChildren: [] }),
  categoryDescription({ parent: JEWELLERY, stockedChildren: ["Rings", "Necklaces"] }),
  categoryDescription({ parent: WOMEN, child: SAREES }),
  categoryDescription({ parent: JEWELLERY, child: RINGS }),
  categoryDescription({ parent: JEWELLERY, child: NECKLACES }),
  productMetaDescription({
    name: "Kasavu Saree",
    description: null,
    categoryName: "Sarees",
    fabric: "Handloom Cotton",
  })!,
  productMetaDescription({
    name: "Copper Cuff",
    description: null,
    categoryName: "Bracelets",
    fabric: null,
  })!,
  productMetaDescription({ name: "Unfiled Piece", description: null })!,
];

/**
 * The claims that may not appear in a GENERIC sentence, and why each one is
 * false today.
 *
 *   linen       — there is none in the catalogue
 *   Kerala      — provenance is mixed, some pieces trace to West Bengal, and
 *                 most rows store no origin at all
 *   the UK      — the storefront sells into India and nowhere else
 *   woven/loom  — a textile claim, applied site-wide it also covers jewellery
 */
/**
 * THE BRAND NAME IS REMOVED BEFORE ANY TEXTILE SWEEP. "THE WOVENNE" contains
 * "woven", so every sentence on the site would fail on the strength of its own
 * signature. The name is a name; what surrounds it is the claim.
 */
const withoutBrandName = (line: string) =>
  line.split(new RegExp(SITE_NAME, "gi")).join(" ");

const FORBIDDEN = [
  { word: "linen", why: "no linen is stocked" },
  { word: "kerala", why: "provenance is mixed and mostly unrecorded" },
  { word: "the uk", why: "the storefront is India-only" },
  { word: "united kingdom", why: "the storefront is India-only" },
  { word: "woven in kerala", why: "both halves are unsupported" },
  { word: "direct from the loom", why: "unverified supply claim" },
];

console.log("\n=== TRUTHFULNESS: no generic sentence makes an unsupported claim ===");

for (const { word, why } of FORBIDDEN) {
  const offenders = GENERIC_COPY.filter((line) => line.toLowerCase().includes(word));
  check(`nothing generic says "${word}"`, offenders, [], why);
}

ok(
  "and every generic sentence is non-empty",
  GENERIC_COPY.every((line) => typeof line === "string" && line.trim().length > 0)
);

console.log("\n=== TRUTHFULNESS: a mixed-catalogue sentence makes no textile claim ===");

/**
 * THE AMBIGUITY THIS SECTION EXISTS FOR.
 *
 * "Handloom cotton sarees, clothing and jewellery ... Woven in India" is not a
 * false sentence about sarees. It is a false sentence about NECKLACES, because
 * "Handloom cotton" attaches to the noun beside it while a trailing "Woven in
 * India" attaches to the whole list. The catalogue is 31 cotton pieces and 2
 * jewellery pieces, so any generic description naming both has to leave the
 * production claim out — India is right for the cloth and unsayable in a
 * sentence that also mentions metal.
 *
 * The site-wide fallbacks are read out of the files rather than restated here,
 * so the assertion is about what actually ships.
 */
const readSrc = (p: string) => fs.readFileSync(p, "utf8");

/**
 * The value of `const NAME = "..."`, however it is wrapped.
 *
 * Read out of the file rather than imported, because these constants are module
 * -private to their routes — and because reading the source is the only way to
 * assert about the string that actually ships rather than a copy of it kept
 * here, which is exactly the copy that would stop matching.
 */
function namedStrings(src: string, name: string): string[] {
  const found: string[] = [];
  const re = new RegExp(`const ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) found.push(m[1]);
  return found;
}

const MIXED_CATALOGUE_COPY: { where: string; text: string }[] = [
  ...namedStrings(readSrc("app/layout.tsx"), "SITE_DESCRIPTION").map((text) => ({
    where: "app/layout.tsx SITE_DESCRIPTION",
    text,
  })),
  ...namedStrings(readSrc("app/(storefront)/in/page.tsx"), "DESCRIPTION").map((text) => ({
    where: "/in DESCRIPTION",
    text,
  })),
  ...namedStrings(readSrc("app/(storefront)/in/shop/page.tsx"), "DESCRIPTION").map((text) => ({
    where: "/in/shop DESCRIPTION",
    text,
  })),
];

check("all three mixed-catalogue descriptions were found", MIXED_CATALOGUE_COPY.length, 3,
  "if this drops to 0 the sweep below is asserting nothing");

for (const { where, text } of MIXED_CATALOGUE_COPY) {
  ok(`${where} names jewellery`, /jewellery/i.test(text),
    "these are the sentences that mix cloth and metal");
}

/**
 * Production verbs, not materials, and matched as WHOLE WORDS.
 *
 * "cotton" is fine in a mixed sentence because it sits against "sarees", and so
 * is "handloom" for the same reason — "Handloom cotton sarees, clothing and
 * jewellery" attaches both adjectives to the noun beside them. A free-standing
 * "woven" or "from the loom" has nothing to attach to and takes the whole list
 * with it, jewellery included.
 *
 * Which is why the boundaries matter: \bloom\b must NOT fire on "handloom",
 * and does not, because there is no word boundary inside it.
 */
for (const verb of ["woven", "weave", "handwoven", "loom", "looms", "spun", "hand-woven"]) {
  const offenders = MIXED_CATALOGUE_COPY
    .filter(({ text }) =>
      new RegExp(`\\b${verb}\\b`, "i").test(withoutBrandName(text))
    )
    .map(({ where }) => where);
  check(`no mixed-catalogue description says "${verb}"`, offenders, [],
    "it would read as a claim about the jewellery");
}
ok(
  "while \"handloom cotton sarees\" is still allowed to say handloom",
  MIXED_CATALOGUE_COPY.every(({ text }) => /handloom cotton sarees/i.test(text)),
  "the adjective is scoped to the noun beside it, which is the whole point"
);

console.log("\n=== TRUTHFULNESS: the country is always capitalised ===");

/**
 * "shipped across India." shipped on 26 of 33 product pages, because the
 * mid-sentence form of the closing clause was produced with toLowerCase() and
 * that lowercased the country with it.
 */
const EVERY_GENERATED: string[] = [
  ...GENERIC_COPY,
  ...MIXED_CATALOGUE_COPY.map(({ text }) => text),
];

for (const wrong of ["india", "kerala", "the wovenne's jewellery", "₹ "]) {
  if (wrong === "india" || wrong === "kerala") {
    const offenders = EVERY_GENERATED.filter((line) =>
      new RegExp(`\\b${wrong}\\b`).test(line)
    );
    check(`nothing says "${wrong}" in lower case`, offenders, [],
      "the country and the state are proper nouns wherever they appear");
  }
}

ok(
  "every mention of India is capitalised",
  EVERY_GENERATED.every((line) => !/\bindia\b/.test(line)),
);
check(
  "the mid-sentence closing clause keeps the capital",
  productMetaDescription({ name: "Red saree", description: null, fabric: "Cotton" }),
  `Red saree — Cotton. From ${SITE_NAME}, shipped across India.`,
  "lower-case in \"shipped\", capital in \"India\""
);
ok(
  "and \"shipped across india\" appears in no generated string at all",
  !EVERY_GENERATED.some((line) => line.includes("shipped across india"))
);

console.log("\n=== TRUTHFULNESS: jewellery is never described as cloth ===");

const JEWELLERY_COPY = [
  categoryTitle({ parent: JEWELLERY }),
  categoryTitle({ parent: JEWELLERY, child: RINGS }),
  categoryDescription({ parent: JEWELLERY, stockedChildren: ["Rings", "Necklaces"] }),
  categoryDescription({ parent: JEWELLERY, child: RINGS }),
  categoryDescription({ parent: JEWELLERY, child: NECKLACES }),
  productMetaDescription({
    name: "Copper Cuff",
    description: null,
    categoryName: "Bracelets",
    fabric: null,
  })!,
];

for (const textile of ["linen", "cotton", "woven", "handloom", "loom", "fabric", "cloth", "weave"]) {
  const offenders = JEWELLERY_COPY.filter((line) =>
    withoutBrandName(line).toLowerCase().includes(textile)
  );
  check(`jewellery copy never says "${textile}"`, offenders, []);
}

console.log("\n=== CATEGORY TITLES: an audience takes \"for\", a category does not ===");

check("a parent is its own name", categoryTitle({ parent: WOMEN }), `Women | ${SITE_NAME}`);
check("including one that is a kind of thing", categoryTitle({ parent: JEWELLERY }), `Jewellery | ${SITE_NAME}`);
check(
  "a child under an audience reads naturally",
  categoryTitle({ parent: WOMEN, child: SAREES }),
  `Sarees for Women | ${SITE_NAME}`
);
check("and under the other audience too", categoryTitle({ parent: MEN, child: DHOTIS }), `Dhotis for Men | ${SITE_NAME}`);
check(
  "a child under a category stands on its own",
  categoryTitle({ parent: JEWELLERY, child: RINGS }),
  `Rings | ${SITE_NAME}`,
  "\"Rings for Jewellery\" is the sentence this rule exists to prevent"
);
check("and its sibling likewise", categoryTitle({ parent: JEWELLERY, child: NECKLACES }), `Necklaces | ${SITE_NAME}`);

ok(
  "no title anywhere reads \"{child} for {non-audience parent}\"",
  ![RINGS, NECKLACES].some((child) =>
    categoryTitle({ parent: JEWELLERY, child }).includes(`for ${JEWELLERY.name}`)
  )
);

check("women is an audience", isAudienceCategory("women"), true);
check("men is an audience", isAudienceCategory("men"), true);
check("jewellery is not", isAudienceCategory("jewellery"), false);
check("a section nobody has thought of yet is not", isAudienceCategory("home"), false,
  "unlisted falls to the plainer shape, never the wrong one");
check("matching is case- and space-insensitive on the slug", isAudienceCategory(" Women "), true);

console.log("\n=== CATEGORY DESCRIPTIONS: they name what is actually filed there ===");

check(
  "a stocked audience section names its sub-categories",
  categoryDescription({ parent: WOMEN, stockedChildren: ["Sarees"] }),
  `Shop Sarees for women at ${SITE_NAME}. Shipped across India.`
);
check(
  "a stocked category section names them without \"for\"",
  categoryDescription({ parent: JEWELLERY, stockedChildren: ["Rings", "Necklaces"] }),
  `Shop Rings and Necklaces at ${SITE_NAME}. Shipped across India.`
);
check(
  "three are listed with a serial comma-free join",
  categoryDescription({ parent: JEWELLERY, stockedChildren: ["Rings", "Necklaces", "Earrings"] }),
  `Shop Rings, Necklaces and Earrings at ${SITE_NAME}. Shipped across India.`
);
check(
  "beyond four it stops listing",
  categoryDescription({
    parent: JEWELLERY,
    stockedChildren: ["Rings", "Necklaces", "Earrings", "Bangles", "Anklets"],
  }),
  `Shop Rings, Necklaces, Earrings and Bangles and more at ${SITE_NAME}. Shipped across India.`
);
check(
  "an empty section says what it is and stops",
  categoryDescription({ parent: MEN, stockedChildren: [] }),
  `Men from ${SITE_NAME}. Shipped across India.`,
  "it is noindex in that state anyway"
);
check(
  "a sub-category under an audience",
  categoryDescription({ parent: WOMEN, child: SAREES }),
  `Sarees for women, from ${SITE_NAME}. Shipped across India.`
);
check(
  "a sub-category under a category",
  categoryDescription({ parent: JEWELLERY, child: RINGS }),
  `Rings from ${SITE_NAME}'s jewellery collection. Shipped across India.`
);

console.log("\n  — a section never borrows its only child's words —");

for (const [parent, child] of [[WOMEN, SAREES], [MEN, DHOTIS], [JEWELLERY, RINGS]] as const) {
  check(
    `/${parent.slug} and /${parent.slug}/${child.slug} describe themselves differently`,
    categoryDescription({ parent, stockedChildren: [child.name] }) ===
      categoryDescription({ parent, child }),
    false,
    "one stocked child used to make the two byte-identical"
  );
}

ok(
  "every category description fits a search result",
  GENERIC_COPY.every((line) => line.length <= META_DESCRIPTION_MAX)
);

console.log("\n=== EMPTY CATEGORIES: available, linked, and not submitted ===");

check("an empty category is noindex, follow", emptyCategoryRobots([]), { index: false, follow: true },
  "the links out of it still matter; the page itself does not");
check("a category with one stocked child is indexable", emptyCategoryRobots([SAREES]), undefined,
  "undefined, not index:true — it simply stops being an exception");
check("and with several", emptyCategoryRobots([SAREES, DHOTIS, RINGS]), undefined);
ok("follow is never turned off", emptyCategoryRobots([])!.follow === true,
  "the category architecture stays crawlable while it is empty");
ok(
  "the indexable answer adds no robots key at all",
  emptyCategoryRobots([RINGS]) === undefined,
  "so a stocked category inherits whatever the site-wide default is"
);

console.log("\n  — \"could not tell\" is not \"empty\" —");

check(
  "an unreadable catalogue asserts nothing",
  emptyCategoryRobots(null),
  undefined,
  "a transient read failure must not deindex a stocked section"
);
check(
  "an empty nav tree reports unknown rather than empty",
  stockedChildrenOf([], "women"),
  null,
  "getNavCategoryTree fails closed, and [] is the shape that failure takes"
);
check(
  "a section absent from a NON-empty tree is a real, empty answer",
  stockedChildrenOf([{ slug: "women", children: [SAREES] }], "jewellery"),
  []
);
check(
  "a stocked section reports its children",
  stockedChildrenOf([{ slug: "jewellery", children: [RINGS, NECKLACES] }], "jewellery"),
  [RINGS, NECKLACES]
);
check(
  "narrowing to one child keeps a stocked answer",
  stockedSelf([RINGS, NECKLACES], "rings"),
  [RINGS]
);
check(
  "narrowing to an unstocked child gives empty",
  stockedSelf([RINGS], "necklaces"),
  []
);
check(
  "narrowing preserves \"could not tell\"",
  stockedSelf(null, "rings"),
  null,
  "the distinction must survive being narrowed, or it was never drawn"
);
check(
  "so an unreadable catalogue leaves a sub-category page indexable",
  emptyCategoryRobots(stockedSelf(stockedChildrenOf([], "jewellery"), "rings")),
  undefined
);
check(
  "while a readable one still noindexes the empty sub-category",
  emptyCategoryRobots(
    stockedSelf(stockedChildrenOf([{ slug: "jewellery", children: [RINGS] }], "jewellery"), "necklaces")
  ),
  { index: false, follow: true }
);
check(
  "and leaves the stocked sibling alone",
  emptyCategoryRobots(
    stockedSelf(stockedChildrenOf([{ slug: "jewellery", children: [RINGS] }], "jewellery"), "rings")
  ),
  undefined
);
check(
  "matching is on the slug, not the editable name",
  stockedSelf([{ slug: "rings", name: "Rings (Renamed)" }], "rings"),
  [{ slug: "rings", name: "Rings (Renamed)" }]
);

console.log("\n=== META DESCRIPTIONS: one line, whole words ===");

check("blank prose yields no description at all", metaDescription("   "), undefined);
check("null likewise", metaDescription(null), undefined);
check("undefined likewise", metaDescription(undefined), undefined);
check("a short line is returned unchanged", metaDescription("A cotton saree."), "A cotton saree.");
check(
  "newlines and runs of space collapse to one space",
  metaDescription("A cotton saree.\n\n  Woven by hand.\tSoftens with wear."),
  "A cotton saree. Woven by hand. Softens with wear."
);
ok(
  "no collapsed description carries a line break",
  !metaDescription("one\ntwo\r\nthree")!.match(/[\r\n]/)
);

const LONG =
  "A handloom pure cotton saree in classic ivory, with a fine gold-tone border " +
  "and a matching unstitched blouse piece, woven on a pit loom by a family that " +
  "has worked this design for three generations and counting.";
const truncated = metaDescription(LONG)!;

ok("a long description is truncated", truncated.length < LONG.length);
ok("to no more than the limit plus its ellipsis", truncated.length <= META_DESCRIPTION_MAX + 1);
ok("it ends with an ellipsis", truncated.endsWith("…"));
ok(
  "the cut lands on a word boundary",
  LONG.startsWith(truncated.slice(0, -1)) &&
    (LONG[truncated.length - 1] === " " || LONG[truncated.length - 1] === undefined),
  "the character after the kept text is a space, so no word was split"
);
ok(
  "every kept word is a whole word of the original",
  truncated
    .slice(0, -1)
    .split(" ")
    .every((word) => LONG.split(/\s+/).includes(word))
);
check(
  "a comma left dangling by the cut is removed",
  metaDescription("aaaa bbbb, cccccc", 11),
  "aaaa bbbb…",
  "\"aaaa bbbb, …\" reads as a typo"
);
check(
  "one word longer than the limit is cut hard rather than returned over-length",
  metaDescription("aaaaaaaaaaaaaaaaaaaa", 10),
  "aaaaaaaaaa…",
  "that shape is a slug, not a sentence"
);

console.log("\n=== OPEN GRAPH: the four keys that kept going missing ===");

const og = openGraph({ title: "Sarees | THE WOVENNE", description: "x", path: cPath("/women/sarees") });

check("type defaults to website", og.type, "website");
check("siteName is always the brand", og.siteName, SITE_NAME);
check("title is carried", og.title, "Sarees | THE WOVENNE");
check("description is carried", og.description, "x");
check("url is absolute on the customer origin", og.url, `${ORIGIN}/in/women/sarees`);
check("an image is always present", og.images, [DEFAULT_OG_IMAGE]);

check(
  "a product cover image is preserved, not replaced",
  openGraph({ title: "t", images: ["https://cdn.test/cover.jpg"] }).images,
  ["https://cdn.test/cover.jpg"],
  "the existing correct behaviour on both product routes"
);
check(
  "a null cover falls back to the shared mark rather than shipping nothing",
  openGraph({ title: "t", images: [null] }).images,
  [DEFAULT_OG_IMAGE]
);
check("no path means no url key", "url" in JSON.parse(JSON.stringify(openGraph({ title: "t" }))), false);
check("a journal post is an article", openGraph({ title: "t", type: "article" }).type, "article");
check("and still carries siteName", openGraph({ title: "t", type: "article" }).siteName, SITE_NAME);

for (const [label, block] of [
  ["website", openGraph({ title: "t", description: "d", path: cPath("/shop") })],
  ["article", openGraph({ title: "t", description: "d", path: cPath("/journal/x"), type: "article" })],
] as const) {
  ok(`${label}: siteName cannot be dropped`, block.siteName === SITE_NAME);
  ok(`${label}: type cannot be dropped`, Boolean(block.type));
  ok(`${label}: an image cannot be dropped`, block.images.length > 0);
}

// ── Source guards ─────────────────────────────

/**
 * Comments stripped, string literals kept.
 *
 * NECESSARY, because the route files now EXPLAIN the claims they used to make —
 * "this said handloom linen from Kerala, and here is why it could not stay". A
 * plain text search would read those explanations as the defect. A scanner that
 * knows it is inside a string does not, and it leaves `https://` in
 * metadataBase alone for the same reason.
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
    // Inside a string literal: escapes are copied whole so \" does not close it.
    if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (src[i] === mode) mode = "code";
    out += src[i++];
  }
  return out;
}

const read = (p: string) => fs.readFileSync(p, "utf8");

/**
 * The files that compose a page's GENERIC metadata — its identity as a route,
 * rather than a description read off one catalogue row.
 *
 * THE PRODUCT AND JOURNAL ROUTES ARE NOT HERE, and their absence is a seam and
 * not an oversight: a description composed from one product's name and fabric is
 * a different kind of claim from a category template, and
 * scripts/seo-descriptions.test.ts holds those four routes to the same rules.
 * Splitting the two keeps each suite able to pass on its own change.
 */
const METADATA_FILES = [
  "app/layout.tsx",
  "app/(storefront)/in/page.tsx",
  "app/(storefront)/in/shop/page.tsx",
  "app/(storefront)/in/customer-style/page.tsx",
  "app/(storefront)/in/[slug]/page.tsx",
  "app/(storefront)/in/[slug]/[child]/page.tsx",
  "app/(storefront)/in/collection/[slug]/page.tsx",
  "lib/metadata.ts",
  "lib/seo.ts",
];

console.log("\n=== SOURCE GUARDS: no route writes a false claim back into a literal ===");

// The journal INDEX is the one exclusion, and it is deliberate: its description
// is about the articles and matches the standfirst printed on the page itself.
// Editorial copy was out of scope for this change, and a tag that disagreed
// with the page under it would be a different defect from the one being fixed.
/**
 * Two uses of the word "linen" in this codebase are not claims about cloth, and
 * are removed before the sweep rather than excused after it:
 *
 *   bg-linen, linen/40  the PALETTE COLOUR (--color-linen, #f0ead6). A cream
 *                       named after a fibre, on background utilities.
 *   WhyLinen, why_linen the Why Us component and its CMS key. Renaming those
 *                       is a content decision and was explicitly out of scope.
 *
 * Anything else the word appears in is prose, and prose is what this checks.
 */
const NON_PROSE: RegExp[] = [
  /\b(?:bg|text|border|from|to|via|ring|fill|stroke)-linen(?:\/\d+)?\b/g,
  /\bwhylinen\b/g,
  /\bwhy_linen\b/g,
];

const sweptFiles = METADATA_FILES.map((file) => {
  let src = stripComments(read(file)).toLowerCase();
  for (const pattern of NON_PROSE) src = src.replace(pattern, " ");
  return [file, src] as const;
});

for (const { word, why } of FORBIDDEN) {
  const offenders = sweptFiles.filter(([, src]) => src.includes(word)).map(([file]) => file);
  check(`no metadata file has a live "${word}"`, offenders, [], why);
}

ok(
  "the stripper is working — the removed claims ARE still in the comments",
  read("app/(storefront)/in/shop/page.tsx").toLowerCase().includes("linen"),
  "if this ever fails, the sweep above is passing for the wrong reason"
);

console.log("\n=== SOURCE GUARDS: openGraph is built, never spelled out ===");

for (const file of METADATA_FILES) {
  if (file === "lib/seo.ts") continue; // where the builder lives
  const src = stripComments(read(file));
  if (!/openGraph/.test(src)) continue;
  ok(
    `${file.replace("app/(storefront)/", "")} builds its openGraph`,
    /openGraph:\s*openGraph\(/.test(src) && !/openGraph:\s*\{/.test(src),
    "an object literal silently drops siteName, type and the image"
  );
}

ok("and the root layout", /openGraph:\s*openGraph\(/.test(stripComments(read("app/layout.tsx"))));

console.log("\n=== SOURCE GUARDS: the pages that changed say what they now say ===");

const home = stripComments(read("app/(storefront)/in/page.tsx"));
ok("the home page has a title of its own", /title:\s*TITLE/.test(home));
ok("and a description of its own", /description:\s*DESCRIPTION/.test(home));
ok("and keeps its canonical unchanged", home.includes('canonical: cPath("/")'));

const parent = stripComments(read("app/(storefront)/in/[slug]/page.tsx"));
const childRoute = stripComments(read("app/(storefront)/in/[slug]/[child]/page.tsx"));
ok("the parent category route builds its title", parent.includes("categoryTitle("));
ok("and its robots directive", parent.includes("emptyCategoryRobots("));
ok("the sub-category route builds its title", childRoute.includes("categoryTitle("));
ok("and its robots directive", childRoute.includes("emptyCategoryRobots("));
ok(
  "neither decides emptiness from a list of slugs",
  !/\[\s*"(sarees|rings|necklaces)"/.test(parent + childRoute),
  "which sub-categories are empty is a state, not a constant"
);

const brandStory = read("components/home/BrandStory.tsx");
ok(
  "the BrandStory image no longer describes linen it does not show",
  !brandStory.toLowerCase().includes('alt="an artisan weaving linen')
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

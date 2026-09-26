/**
 * Every canonical names the URL that actually serves the page.
 *
 *   npx tsx scripts/seo-canonical.test.ts
 *
 * Exits non-zero on failure.
 *
 * THE DEFECT THIS GUARDS HAS HAPPENED ONCE ALREADY. The sub-category canonical
 * was written out by hand as `/${parent.slug}/${child.slug}`, which lost the
 * market prefix and pointed at a URL that only 308s back — for as long as that
 * page had existed. It looked correct in review, because a path spelled out at
 * the call site looks like a path. Only the helper knows where the site lives.
 *
 * So the rule these tests hold is narrow and absolute: a canonical is built by
 * a helper, is absolute, is /in-prefixed, and is the page's own address.
 */
import fs from "node:fs";
import {
  rootSlugHref,
  categoryHref,
  productHref,
  journalHref,
  collectionHref,
} from "../lib/urls";
import { cPath } from "../lib/country";
import { customerUrl } from "../lib/seo";

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
/** What metadataBase does to a relative canonical, so tests read as Google sees it. */
const resolved = (path: string) => customerUrl(path);

console.log("\n=== CONTENT PAGES (served through /in/[slug]) ===");

check("/in/policies", rootSlugHref("policies"), "/in/policies");
check("/in/privacy-policy", rootSlugHref("privacy-policy"), "/in/privacy-policy");
check("/in/about", rootSlugHref("about"), "/in/about");
check("/in/faq", rootSlugHref("faq"), "/in/faq");

console.log("\n  — pages not yet written get one the moment they are published —");
for (const slug of ["contact", "shipping", "returns", "size-guide"]) {
  check(`a future /${slug} page`, rootSlugHref(slug), `/in/${slug}`,
    "pages are rows; nothing to remember per page");
}

console.log("\n=== PARENT CATEGORY LANDING PAGES ===");

check("/in/women", rootSlugHref("women"), "/in/women");
check("/in/men", rootSlugHref("men"), "/in/men");
check("/in/jewellery", rootSlugHref("jewellery"), "/in/jewellery");

console.log("\n=== HOME ===");

check("/in", cPath("/"), "/in", "not a bare '/', which would only 308");
check("resolves absolute", resolved(cPath("/")), `${ORIGIN}/in`);
ok("and carries no trailing slash", !resolved(cPath("/")).endsWith("/"));

console.log("\n=== JOURNAL, COLLECTIONS AND WORN BY YOU ===");

check("/in/journal", cPath("/journal"), "/in/journal");
check("a journal post", journalHref("why-does-linen-crease"), "/in/journal/why-does-linen-crease");
check("another", journalHref("what-does-it-take-to-make-one-saree"),
  "/in/journal/what-does-it-take-to-make-one-saree");
check("a seasonal collection", collectionHref("onam-edit"), "/in/collection/onam-edit");
check("/in/customer-style", cPath("/customer-style"), "/in/customer-style",
  "the route keeps the slug the URL was indexed under");

console.log("\n=== EVERY CANONICAL IS ABSOLUTE, /in-PREFIXED, AND NOT A REDIRECT ===");

/**
 * EVERY INDEXABLE STOREFRONT ROUTE, one canonical each. If a route family is
 * added and not listed here, the completeness check further down is the thing
 * that notices.
 */
const everyCanonical = [
  cPath("/"),
  cPath("/shop"),
  cPath("/journal"),
  cPath("/customer-style"),
  ...["policies", "privacy-policy", "about", "faq", "contact"].map(rootSlugHref),
  ...["women", "men", "jewellery"].map(rootSlugHref),
  categoryHref("women", "sarees"),
  categoryHref("men", "dhotis"),
  productHref({ slug: "red-saree", category_slug: "sarees", category_parent_slug: "women" }),
  productHref({ slug: "unfiled", category_slug: null, category_parent_slug: null }),
  journalHref("why-does-linen-crease"),
  collectionHref("onam-edit"),
];

ok("all start at the market prefix", everyCanonical.every((p) => p === "/in" || p.startsWith("/in/")),
  "an unprefixed path is a URL that only 308s");
ok("none is a bare root", everyCanonical.every((p) => p !== "/"));
ok("none ends in a trailing slash", everyCanonical.every((p) => !p.endsWith("/")));
ok("none doubles a slash", everyCanonical.every((p) => !p.includes("//")));
ok("all resolve absolute on the production origin",
  everyCanonical.every((p) => resolved(p).startsWith(`${ORIGIN}/in`)));
check("no two distinct pages share a canonical", everyCanonical.length, new Set(everyCanonical).size);
ok("none carries a query string", everyCanonical.every((p) => !p.includes("?") && !p.includes("&")),
  "a canonical naming a filtered or tagged URL would defeat the point of having one");
ok("none carries a fragment", everyCanonical.every((p) => !p.includes("#")));
ok("none is protocol-relative or absolute-by-accident",
  everyCanonical.every((p) => p.startsWith("/in") && !p.startsWith("//")));

console.log("\n=== EXISTING BEHAVIOUR IS UNCHANGED ===");

check("sub-category", categoryHref("women", "sarees"), "/in/women/sarees");
check("product", productHref({ slug: "red-saree", category_slug: "sarees", category_parent_slug: "women" }),
  "/in/women/sarees/red-saree");
check("unfiled product keeps its flat fallback",
  productHref({ slug: "x", category_slug: null, category_parent_slug: null }), "/in/product/x");
check("shop stays the unfiltered path", cPath("/shop"), "/in/shop");
check("a section canonical and its sub-category canonical differ",
  rootSlugHref("women") === categoryHref("women", "sarees"), false);
check("rootSlugHref agrees with cPath for the same slug", rootSlugHref("women"), cPath("/women"));

console.log("\n=== SOURCE GUARDS: built by a helper, never spelled out ===");

const read = (p: string) => fs.readFileSync(p, "utf8");
const slugRoute = read("app/(storefront)/in/[slug]/page.tsx");
const childRoute = read("app/(storefront)/in/[slug]/[child]/page.tsx");
const productRoute = read("app/(storefront)/in/[slug]/[child]/[product]/page.tsx");
const legacyRoute = read("app/(storefront)/in/product/[slug]/page.tsx");
const shopRoute = read("app/(storefront)/in/shop/page.tsx");
const home = read("app/(storefront)/in/page.tsx");

ok("the category branch uses rootSlugHref", slugRoute.includes("canonical: rootSlugHref(category.slug)"));
ok("the page branch uses rootSlugHref", slugRoute.includes("canonical: rootSlugHref(page.slug)"));
ok("both are built from the RESOLVED slug, not params",
  !/canonical:\s*rootSlugHref\(params\./.test(slugRoute),
  "the canonical can only name what is actually served");
ok("the home page canonical goes through cPath", home.includes('canonical: cPath("/")'));
ok("no canonical anywhere is a hand-written template literal",
  ![slugRoute, childRoute, productRoute, legacyRoute, shopRoute, home]
    .some((f) => /canonical:\s*`/.test(f)),
  "this exact shape is the defect that shipped once");

ok("sub-category canonical untouched", childRoute.includes("canonical: categoryHref(parent.slug, child.slug)"));
ok("product canonical untouched", productRoute.includes("canonical: productHref(product)"));
ok("legacy product canonical untouched", legacyRoute.includes("canonical: productHref(product)"));
ok("shop canonical untouched", shopRoute.includes('canonical: cPath("/shop")'));

/*
 * THE HOME PAGE USED TO BE ASSERTED THE OTHER WAY ROUND, and the reason it
 * changed is worth keeping. It carried only a canonical, so that declaring an
 * openGraph key could not silently discard the root layout's type, siteName and
 * image — a real hazard, since Next replaces that object wholesale.
 *
 * openGraph() now carries all four, so the hazard is closed at the builder
 * rather than by one route abstaining. What abstaining actually cost was the
 * page's own words: /in inherited the layout's description, and the layout's
 * description advertised linen for the UK.
 *
 * So the rule here is no longer "declare nothing". It is "declare it through
 * the helper" — and scripts/seo-metadata.test.ts holds the same line for every
 * other route.
 */
ok("the home page builds its openGraph through the helper",
  /openGraph:\s*openGraph\(/.test(home),
  "an object literal would still drop siteName, type and the image");
ok("and now carries a title and description of its own",
  /title:\s*TITLE/.test(home) && /description:\s*DESCRIPTION/.test(home),
  "inheriting them is what put the root layout's claims on the most-linked page");
ok("its canonical is untouched by any of that",
  /alternates:\s*\{ canonical: cPath\("\/"\) \}/.test(home));

console.log("\n=== COMPLETENESS: every storefront route is accounted for ===");

/**
 * Each public route family, and what it must have. "noindex" and "redirect" are
 * documented reasons NOT to carry a canonical — a page Google is told to skip
 * does not need to nominate itself, and a redirect has no metadata of its own.
 */
const ROUTES: { file: string; expect: "canonical" | "noindex" | "redirect" }[] = [
  { file: "app/(storefront)/in/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/shop/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/[slug]/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/[slug]/[child]/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/[slug]/[child]/[product]/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/product/[slug]/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/journal/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/journal/[slug]/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/collection/[slug]/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/customer-style/page.tsx", expect: "canonical" },
  { file: "app/(storefront)/in/cart/layout.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/checkout/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/checkout/pending/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/checkout/success/layout.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/checkout/cancel/layout.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/search/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/login/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/signup/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/verify/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/forgot-password/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/reset-password/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/account/orders/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/account/profile/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/account/settings/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/account/wishlist/page.tsx", expect: "noindex" },
  { file: "app/(storefront)/in/account/preferences/page.tsx", expect: "redirect" },
];

let unaccounted = 0;
for (const { file, expect } of ROUTES) {
  const src = read(file);
  const has =
    expect === "canonical"
      ? /alternates:\s*\{\s*canonical:/.test(src)
      : expect === "noindex"
        ? /robots:\s*\{\s*index:\s*false/.test(src)
        : /permanentRedirect\(/.test(src);
  if (!has) unaccounted++;
  ok(`${file.replace("app/(storefront)/", "")} — ${expect}`, has);
}
check("no storefront route is unaccounted for", unaccounted, 0);

// Every page.tsx under the storefront must appear in the table above, so a new
// route cannot be added without a deliberate decision about how Google sees it.
const onDisk = fs
  .readdirSync("app/(storefront)/in", { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith("page.tsx"))
  .map((f) => `app/(storefront)/in/${f}`);
const listed = new Set(ROUTES.map((r) => r.file));
const missing = onDisk.filter(
  (f) => !listed.has(f) && !listed.has(f.replace(/page\.tsx$/, "layout.tsx"))
);
check("every storefront page.tsx is listed above", missing, []);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

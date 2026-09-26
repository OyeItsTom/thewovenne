/**
 * An old product URL redirects once, to the page's real /in address.
 *
 *   npx tsx scripts/seo-redirects.test.ts
 *
 * Exits non-zero on failure.
 *
 * TWO DEFECTS THIS GUARDS, BOTH FROM #69 MOVING THE STOREFRONT UNDER /in.
 * product_url_history stores paths unprefixed (migration 0017), and the move
 * changed the routes but not the table. The flat route then looked up
 * "/in/product/<slug>", which no row can match, so every renamed product's old
 * flat link 404'd. And the category route redirected to the table's unprefixed
 * path, which only reached the page after middleware 308'd it a second time.
 *
 * The history table below is a stand-in shaped like the real one: unprefixed
 * keys, resolved by exact match to the product's CURRENT unprefixed path, as
 * resolve_product_path() does. mul-cotton → parrot-green-mul-cotton-saree was
 * observed live; violet-w-blue-border's destination here is a fixture.
 */
import fs from "node:fs";
import {
  categoryProductHistoryPath,
  flatProductHistoryPath,
  resolveMovedPath,
  type HistoryLookup,
} from "../lib/redirects";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const HISTORY: Record<string, string> = {
  "/product/violet-w-blue-border": "/women/sarees/violet-saree-with-blue-border",
  "/women/sarees/mul-cotton": "/women/sarees/parrot-green-mul-cotton-saree",
  "/product/mul-cotton": "/women/sarees/parrot-green-mul-cotton-saree",
};
const REACHABLE = new Set([
  "violet-saree-with-blue-border",
  "parrot-green-mul-cotton-saree",
]);

/** A fake history, recording every key it was asked for. */
function history(
  table: Record<string, string | null> = HISTORY,
  reachable: Set<string> = REACHABLE
): HistoryLookup & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async lookup(path) {
      asked.push(path);
      return table[path] ?? null;
    },
    async isReachable(slug) {
      return reachable.has(slug);
    },
  };
}

/** What the flat route does when its slug is not a current product. */
async function flatRoute(slug: string, h: HistoryLookup) {
  return resolveMovedPath(flatProductHistoryPath(slug), h);
}

/** What the category route does when its product slug is not current. */
async function categoryRoute(parent: string, child: string, product: string, h: HistoryLookup) {
  return resolveMovedPath(categoryProductHistoryPath(parent, child, product), h);
}

async function main() {
  console.log("\n=== A. OLD FLAT URL: /in/product/violet-w-blue-border ===");
  {
    const h = history();
    const to = await flatRoute("violet-w-blue-border", h);
    eq("history is asked for the unprefixed key", h.asked[0], "/product/violet-w-blue-border");
    eq("redirects to the product's /in canonical", to, "/in/women/sarees/violet-saree-with-blue-border");
  }

  console.log("\n=== B. OLD CATEGORY URL: /in/women/sarees/mul-cotton ===");
  {
    const h = history();
    const to = await categoryRoute("women", "sarees", "mul-cotton", h);
    eq("history is asked for the unprefixed key", h.asked[0], "/women/sarees/mul-cotton");
    eq("redirects straight to the /in canonical, no unprefixed hop", to,
      "/in/women/sarees/parrot-green-mul-cotton-saree");
    // The same product through its old flat link lands on the same address.
    eq("the old flat link lands on the same product",
      await flatRoute("mul-cotton", history()), "/in/women/sarees/parrot-green-mul-cotton-saree");
  }

  console.log("\n=== C. NEVER REDIRECTS A PATH TO ITSELF ===");
  {
    const self = { "/women/sarees/parrot-green-mul-cotton-saree": "/women/sarees/parrot-green-mul-cotton-saree" };
    eq("history pointing at the lookup path gives no redirect",
      await categoryRoute("women", "sarees", "parrot-green-mul-cotton-saree", history(self)), null);
  }

  console.log("\n=== D. NO HISTORY, NO DESTINATION ===");
  {
    eq("unknown flat slug", await flatRoute("zz-no-such-thing", history()), null);
    eq("unknown category path", await categoryRoute("women", "sarees", "zz-no-such-thing", history()), null);
    eq("a null row", await flatRoute("gone", history({ "/product/gone": null })), null);
    eq("an empty row", await flatRoute("blank", history({ "/product/blank": "" })), null);
  }

  console.log("\n=== E. DESTINATION SAFETY ===");
  {
    eq("a product customers cannot reach is not a destination",
      await flatRoute("violet-w-blue-border", history(HISTORY, new Set())), null);
    for (const bad of ["//evil.com/x", "https://evil.com/x", "\\\\evil.com\\x", "/\\evil.com", "women/sarees/x"]) {
      eq(`a non-local destination ${JSON.stringify(bad)} is refused`,
        await resolveMovedPath("/product/x", history({ "/product/x": bad }, new Set(["x", bad.split("/").pop() ?? ""]))), null);
    }
    // A destination that already carries the market is not prefixed twice.
    eq("never a double prefix",
      await resolveMovedPath("/product/pre", history({ "/product/pre": "/in/women/sarees/pre-now" }, new Set(["pre-now"]))),
      "/in/women/sarees/pre-now");
    for (const [name, to] of [
      ["A", await flatRoute("violet-w-blue-border", history())],
      ["B", await categoryRoute("women", "sarees", "mul-cotton", history())],
    ] as const) {
      ok(`${name}: destination is a local /in path`, typeof to === "string" && /^\/in\/[^/\\]/.test(to), `got ${to}`);
    }
  }

  console.log("\n=== F. MALFORMED AND UNUSUAL SLUGS ARE EXACT-MATCH MISSES ===");
  {
    for (const slug of ["../women/sarees/mul-cotton", "%2Fevil.com", "/evil.com", "Violet-W-Blue-Border", "violet-w-blue-border/", ""]) {
      const h = history();
      eq(`flat ${JSON.stringify(slug)} → 404`, await flatRoute(slug, h), null);
    }
    eq("category with an encoded slash → 404",
      await categoryRoute("women", "sarees", "mul-cotton%2F..", history()), null);
  }

  console.log("\n=== F. CURRENT SLUGS NEVER REACH THE HISTORY TABLE ===");
  // A route test would need Next and a database. What matters is the order:
  // a current product is served (or sent to its canonical) before history is
  // consulted, so this fix cannot change how a live product URL behaves.
  for (const file of [
    "app/(storefront)/in/product/[slug]/page.tsx",
    "app/(storefront)/in/[slug]/[child]/[product]/page.tsx",
  ]) {
    const src = fs.readFileSync(file, "utf8");
    const body = src.slice(src.indexOf("export default async function"));
    const lookup = body.indexOf("getProductBySlug(");
    const moved = body.indexOf("resolveOldPath(");
    ok(`${file}: current product is looked up first`, lookup >= 0 && moved > lookup);
    ok(`${file}: history only on a miss`, /if \(!product\) \{[\s\S]*?resolveOldPath\(/.test(body));
    ok(`${file}: history key comes from the helper`, /resolveOldPath\(\s*(flat|category)ProductHistoryPath\(/.test(body));
    ok(`${file}: moved destinations still 308`, /if \(moved\) permanentRedirect\(moved\)/.test(body));
    ok(`${file}: a miss still 404s`, /if \(moved\) permanentRedirect\(moved\);\s*notFound\(\)/.test(body));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

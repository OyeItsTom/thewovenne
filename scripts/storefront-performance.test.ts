/**
 * Storefront performance invariants (Performance Optimization, Oct 2026).
 *
 * Each check pins one measured cause of slow mobile loads, so a later edit
 * cannot quietly bring it back:
 *
 *   - grid cards on the first screen painting only after hydration (LCP);
 *   - a below-the-fold lookbook photo preloaded against the hero (LCP);
 *   - browser performance tracing, and the whole Sentry namespace, in the
 *     chunk every page loads;
 *   - supabase-js reaching every page through always-mounted components and
 *     through lib modules that merely sit next to a database read;
 *   - an unused Devanagari font preloaded on every page.
 *
 * Run: npx --cache <scratch>/npmcache --yes tsx@4.19.2 scripts/storefront-performance.test.ts
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import nextConfig from "../next.config.mjs";
import { DEFAULT_CONTENT } from "../lib/content";
import { DEFAULT_CONTENT as DEFAULTS_DIRECT } from "../lib/contentDefaults";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else fail++;
}

const read = (p: string) => readFileSync(p, "utf8");

/** Source with its comments removed — what is actually compiled. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Static (not type-only, not dynamic) imports of a module path. */
function importsStatically(source: string, spec: string): boolean {
  const code = codeOf(source);
  const re = new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+["']${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`, "m");
  return re.test(code);
}

console.log("\n=== first-screen grid cards paint without waiting for JS ===");
const reveal = read("lib/useReveal.ts");
const card = read("components/shop/ProductCard.tsx");
const grid = read("components/shop/ProductGrid.tsx");
check("useReveal can start revealed", /useState\(initiallyRevealed\)/.test(reveal));
check("a revealed-from-start element never observes", reveal.includes("if (!node || initiallyRevealed) return;"));
check("useReveal still defaults to hidden for below-the-fold use", reveal.includes("initiallyRevealed = false"));
check("the card skips the reveal above the fold", card.includes('useReveal<HTMLDivElement>(fold !== "below")'));
check("the card's cover is priority only for fold=priority", card.includes('priority={fold === "priority"}'));
check("the rest of the first row is eager, not preloaded", card.includes('loading={fold === "visible" ? "eager" : undefined}'));
check("cards default to below the fold", card.includes('fold = "below"'));
check("only gallery-hint secondary images remain lazy", !/aria-hidden\s+fill\s+priority/.test(card));
check("the grid's first-row treatment is opt-in", grid.includes("leadsPage = false"));
check("first two cards are priority, next two visible",
  /productIndex < 2\s*\?\s*"priority"\s*:\s*"visible"/.test(grid) && grid.includes("productIndex >= 4"));
check("listing pages opt in",
  read("components/shop/CatalogueListing.tsx").includes("leadsPage") &&
  read("app/(storefront)/in/search/page.tsx").includes("leadsPage") &&
  read("app/(storefront)/in/collection/[slug]/page.tsx").includes("leadsPage"));
check("the PDP's related grid does NOT opt in (it is below the PDP's own LCP)",
  /<ProductGrid products=\{related\} \/>/.test(read("components/product/ProductDetail.tsx")));

console.log("\n=== the home hero is the only preloaded hero image ===");
const lookbook = codeOf(read("components/home/LookbookSections.tsx"));
const hero = codeOf(read("components/home/Hero.tsx"));
check("no lookbook image is priority", !/priority/.test(lookbook));
check("the hero emblem is still priority", /\bpriority\b/.test(hero));
check("the hero still fills the first screen (why the lookbook cannot be above the fold)",
  read("app/globals.css").includes("min-height: calc(100svh - var(--header-h));"));

console.log("\n=== browser Sentry reports errors, without tracing ===");
const nextConfigSrc = read("next.config.mjs");
const clientSentry = codeOf(read("sentry.client.config.ts"));
check("client builds define __SENTRY_TRACING__ false", /__SENTRY_TRACING__:\s*false/.test(nextConfigSrc));
check("client builds define __SENTRY_DEBUG__ false", /__SENTRY_DEBUG__:\s*false/.test(nextConfigSrc));
check("the define is client-only", /if \(!isServer\)/.test(nextConfigSrc));
check("next.config exposes a webpack hook", typeof (nextConfig as { webpack?: unknown }).webpack === "function");
check("the client init no longer asks for traces", !clientSentry.includes("tracesSampleRate"));
check("the client init still sets the DSN", clientSentry.includes("dsn: enabled ? dsn : undefined"));
check("the server keeps its tracing", read("sentry.server.config.ts").includes("tracesSampleRate"));
const globalError = read("app/global-error.tsx");
check("global-error still reports to Sentry", globalError.includes("Sentry.captureException(error)"));
check("global-error imports only captureException, not the namespace",
  globalError.includes('import(/* webpackExports: ["captureException"] */ "@sentry/nextjs")'));

/*
 * The define works through webpack's DefinePlugin — run the hook against a
 * stub and confirm it registers for the client and not for the server.
 */
{
  class DefinePlugin {
    constructor(public definitions: Record<string, unknown>) {}
  }
  const hook = (nextConfig as { webpack: (c: { plugins: unknown[] }, o: unknown) => { plugins: unknown[] } }).webpack;
  const client = hook({ plugins: [] }, { isServer: false, webpack: { DefinePlugin } });
  const server = hook({ plugins: [] }, { isServer: true, webpack: { DefinePlugin } });
  const def = client.plugins[0] as DefinePlugin | undefined;
  check("the hook adds one DefinePlugin to the client build",
    client.plugins.length === 1 && def?.definitions.__SENTRY_TRACING__ === false);
  check("the hook leaves the server build alone", server.plugins.length === 0);
}

console.log("\n=== supabase-js loads only where it is used up front ===");
const lazy = read("lib/supabaseLazy.ts");
check("the lazy loader dynamically imports lib/supabase", lazy.includes('import("./supabase")'));
check("the lazy loader imports supabase-js for TYPES only",
  /import type \{ SupabaseClient \} from "@supabase\/supabase-js"/.test(lazy) && !importsStatically(lazy, "./supabase"));
for (const [file, label] of [
  ["components/account/AccountEntry.tsx", "the nav's account icon"],
  ["components/cart/CartSync.tsx", "the cart sync"],
  ["lib/wishlistStore.ts", "the wishlist store (every card's heart)"],
  ["components/home/CuratedPersonalizer.tsx", "the home personaliser"],
  ["components/product/ReviewFormGate.tsx", "the PDP review gate"],
  ["components/product/ReviewForm.tsx", "the PDP review form"],
] as const) {
  const src = read(file);
  check(`${label} does not import lib/supabase statically`,
    !importsStatically(src, "@/lib/supabase") && !importsStatically(src, "./supabase"));
  check(`${label} uses loadBrowserSupabase`, src.includes("loadBrowserSupabase"));
}
const contentDefaults = read("lib/contentDefaults.ts");
check("contentDefaults has type-only imports",
  codeOf(contentDefaults).split("\n").filter((l) => /^import\s/.test(l)).every((l) => /^import type\s/.test(l)));
check("home client components take defaults from contentDefaults",
  importsStatically(read("components/home/WhyLinen.tsx"), "@/lib/contentDefaults") &&
  importsStatically(read("components/home/BrandStory.tsx"), "@/lib/contentDefaults") &&
  !importsStatically(read("components/home/WhyLinen.tsx"), "@/lib/content") &&
  !importsStatically(read("components/home/BrandStory.tsx"), "@/lib/content"));
check("lib/content still exports the same defaults", DEFAULT_CONTENT === DEFAULTS_DIRECT);
check("the defaults still carry the hero", typeof DEFAULT_CONTENT.home_hero?.cta_label === "string");
const pkg = JSON.parse(read("package.json")) as { sideEffects?: unknown };
check("package.json marks only CSS as side-effectful",
  Array.isArray(pkg.sideEffects) && pkg.sideEffects.length === 1 && pkg.sideEffects[0] === "*.css");
{
  // The sideEffects declaration is only safe while nothing in the app is
  // imported purely for what it does at load time. CSS is the one exception.
  const bare = execSync(
    `grep -rnE "^import ['\\"]" app components lib middleware.ts instrumentation.ts || true`,
    { encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean)
    .filter((l) => !/\.css["']/.test(l));
  check("no side-effect-only imports besides CSS", bare.length === 0);
  if (bare.length) console.log(bare.join("\n"));
}

console.log("\n=== fonts ===");
const layout = read("app/layout.tsx");
check("the script face loads the latin subset only",
  /Tiro_Devanagari_Hindi\(\{\s*subsets: \["latin"\],/.test(layout));
check("brand faces are unchanged",
  layout.includes('weight: ["400", "500", "600", "700"]') && layout.includes('weight: ["400", "500", "700"]'));
check("every face still swaps rather than blocks", (layout.match(/display: "swap"/g) ?? []).length === 3);

console.log("\n=== cart: the empty state keeps the placeholder's box ===");
const cart = read("app/(storefront)/in/cart/page.tsx");
check("placeholder is mt-16 min-h-[11rem]", cart.includes('className="mt-16 min-h-[11rem]" aria-busy="true"'));
check("empty state reserves the same box, at its original position",
  cart.includes('className="mt-16 flex min-h-[11rem] flex-col items-center text-center text-ink/60"'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

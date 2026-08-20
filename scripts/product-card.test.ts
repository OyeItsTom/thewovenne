/** Focused product-card presentation regressions. */
import { readFileSync } from "node:fs";
import { effectivePrice } from "../lib/pricing";
import { stockState } from "../lib/stock";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else fail++;
}

const card = readFileSync("components/shop/ProductCard.tsx", "utf8");
const grid = readFileSync("components/shop/ProductGrid.tsx", "utf8");
const wishlist = readFileSync("components/shop/WishlistButton.tsx", "utf8");
const detail = readFileSync("components/product/ProductDetail.tsx", "utf8");
const utils = readFileSync("lib/utils.ts", "utf8");

/** Source with its comments removed — what the browser actually receives. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

console.log("\n=== preserved business presentation ===");
const sale = effectivePrice({
  price_inr: 5000,
  discount_type: "percent",
  discount_value: 20,
  discount_starts_at: null,
  discount_ends_at: null,
});
check("active sale price remains supported", sale.price === 4000);
check("original price remains available", sale.wasPrice === 5000);
check("zero stock remains sold out", stockState(0).soldOut);
check("positive stock remains available", !stockState(1).soldOut);
check("wishlist control remains on the card", card.includes("<WishlistButton"));
check("wishlist receives the product identity", card.includes("productId={product.id}"));
check("wishlist keeps its enlarged touch target", card.includes('size="sm"'));
check("wishlist uses the restrained photo overlay", card.includes('appearance="overlay"'));

console.log("\n=== photography-first card contract ===");
check("category label is not rendered", !card.includes("product.category"));
check("Quick Add is not rendered", !card.includes("Quick add"));
check("card no longer imports the cart store", !card.includes("useCartStore"));
check("full product name remains in the heading", card.includes("{product.name}"));
check("visual title is clamped to two lines", card.includes("line-clamp-2"));
check("full title remains in the photo link label", card.includes('aria-label={`View ${product.name}`}'));
check("sold-out state remains text", card.includes(">\n              Sold out\n"));
check("multi-image cards expose a gallery indicator", card.includes("data-gallery-indicator"));
check("indicator is conditional on multiple images", card.includes("{hasMany && ("));
check("single-image cards have no status or indicator", card.includes("images.length > 1"));
check("only the first grid card owns discovery", grid.includes("discoveryHint={productIndex === 0}"));

console.log("\n=== the heart stays inside the photograph ===");
// cn() is a plain join: a base `relative` and a caller's `absolute` BOTH land in
// the class attribute, and Tailwind emits `.relative` last, so the base wins and
// `right-2` resolves as `left: -8px`. The heart hung 8-12px outside the frame
// and overflow-hidden clipped it. The fix is that the component owns no
// position at all — so this stops being a race the caller cannot win.
check("cn() still cannot resolve conflicts, which is why this matters",
  utils.includes('inputs.filter(Boolean).join(" ")'));
check("the button declares no position of its own",
  // Comments stripped first: the file EXPLAINS the `relative`/`absolute` clash
  // in prose, and prose is not what ships in a class attribute.
  !/\brelative\b/.test(codeOf(wishlist)));
check("the card positions it absolutely", card.includes('className="absolute right-2 top-2'));
check("the card's heart is inset from both edges", /absolute right-2 top-2[^"]*md:right-3 md:top-3/.test(card));
check("the product page supplies its own positioned box",
  detail.includes('className="relative mt-1 shrink-0'));
check("the 44px target still needs one, and has one",
  wishlist.includes("tap-44"));

console.log("\n=== quiet controls, so the photography dominates ===");
check("no cream disc behind the heart on desktop", !card.includes("md:bg-cream/85"));
check("no shadow or blur behind the heart on desktop", !card.includes("md:shadow-soft") && !card.includes("md:backdrop-blur"));
check("the heart is not hidden until hover", !card.includes("md:opacity-0"));
check("the heart keeps the transparent overlay treatment", wishlist.includes("bg-transparent text-white shadow-none"));
check("the arrows carry no disc, shadow or blur",
  !/bg-cream\/85 text-ink opacity-0 shadow-soft backdrop-blur/.test(card));
check("the arrows are drawn as white chevrons", card.includes("rounded-full text-white opacity-0 transition-opacity"));
check("the arrows keep a legible shadow instead of a surface",
  card.includes("[filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.8))]"));
check("the arrows are 36px, so the 44px target lands on the frame edge",
  card.includes("h-9 w-9") && !card.includes("h-8 w-8"));
check("the arrows still carry the enlarged target", (card.match(/tap-44/g) ?? []).length === 2);
check("the arrows are still absent on mobile", card.includes("md:group-hover:opacity-100"));
check("no permanent mobile arrows crept in", !/opacity-100 md:opacity-0/.test(card));
check("the arrows remain keyboard-operable", card.includes("focus-visible:pointer-events-auto focus-visible:opacity-100"));
check("the arrows still stop at the ends", card.includes("disabled={atStart}") && card.includes("disabled={atEnd}"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

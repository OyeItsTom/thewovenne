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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

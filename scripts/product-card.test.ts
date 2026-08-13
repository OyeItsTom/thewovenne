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

console.log("\n=== photography-first card contract ===");
check("category label is not rendered", !card.includes("product.category"));
check("Quick Add is not rendered", !card.includes("Quick add"));
check("card no longer imports the cart store", !card.includes("useCartStore"));
check("full product name remains in the heading", card.includes("{product.name}"));
check("visual title is clamped to two lines", card.includes("line-clamp-2"));
check("sold-out state remains text", card.includes(">\n              Sold out\n"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * The stock boundary at checkout-start, exercised headlessly.
 *
 * priceCart is the last thing between a cart and a Razorpay order, and the
 * only stock check that is not running in the customer's browser. These tests
 * hand it a fake catalogue and confirm that what it refuses is decided by the
 * shelf, not by how the request was shaped: split lines are summed, a
 * quantity typed into the request body is still a quantity, and a product
 * with no sizes is counted rather than merely declared "in stock". Run:
 *
 *   npx tsx scripts/checkout-pricing.test.ts
 *
 * No network, no database. Exits non-zero on failure.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { priceCart } from "../lib/checkoutPricing";
import type { CartItem } from "../lib/store";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

// ── The catalogue under test ───────────────────
//
// Only the three reads priceCart makes are modelled: checkout_prices, the
// product_sizes rows, and the published version's own count.

interface Catalogue {
  prices: { product_id: string; name: string; price_inr: number; cost_price_inr: number | null; sku: string | null; in_stock: boolean }[];
  sizes: { id: string; product_id: string; label: string; sort_order: number; stock_quantity: number }[];
  versions: { product_id: string; stock_quantity: number }[];
  versionsFail?: boolean;
}

function fakeClient(cat: Catalogue): SupabaseClient {
  // A query that answers the same thing however it is chained.
  const query = (result: { data: unknown; error: { message: string } | null }) => {
    const q: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej),
    };
    for (const m of ["select", "in", "eq", "order"]) q[m] = () => q;
    return q;
  };

  return {
    rpc: async (name: string, args: { p_ids: string[] }) => {
      if (name !== "checkout_prices") throw new Error(`unexpected rpc ${name}`);
      return { data: cat.prices.filter((p) => args.p_ids.includes(p.product_id)), error: null };
    },
    from: (table: string) => {
      if (table === "product_sizes") return query({ data: cat.sizes, error: null });
      if (table === "product_versions") {
        return cat.versionsFail
          ? query({ data: null, error: { message: "boom" } })
          : query({ data: cat.versions, error: null });
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

const SHIRT = "p-shirt";
const SAREE = "p-saree";
const SAREE_GONE = "p-saree-gone";

const catalogue: Catalogue = {
  prices: [
    { product_id: SHIRT, name: "Linen Shirt", price_inr: 1500, cost_price_inr: 600, sku: "SH-1", in_stock: true },
    { product_id: SAREE, name: "Zari Dhoti", price_inr: 6000, cost_price_inr: null, sku: null, in_stock: true },
    { product_id: SAREE_GONE, name: "Sold Saree", price_inr: 6000, cost_price_inr: null, sku: null, in_stock: false },
  ],
  sizes: [
    { id: "s1", product_id: SHIRT, label: "S", sort_order: 1, stock_quantity: 3 },
    { id: "s2", product_id: SHIRT, label: "M", sort_order: 2, stock_quantity: 2 },
    { id: "s3", product_id: SHIRT, label: "L", sort_order: 3, stock_quantity: 0 },
  ],
  versions: [
    // A sized product's version count is the derived sum (0056) and must be
    // ignored in favour of the size rows — it is deliberately misleading here.
    { product_id: SHIRT, stock_quantity: 5 },
    { product_id: SAREE, stock_quantity: 2 },
    { product_id: SAREE_GONE, stock_quantity: 0 },
  ],
};

const line = (id: string, size: string, quantity: number): CartItem => ({
  id,
  slug: id,
  name: "whatever the browser says",
  price_inr: 1,
  image_url: null,
  size,
  quantity,
});

const price = (items: CartItem[], cat: Catalogue = catalogue) => priceCart(items, fakeClient(cat));

async function main() {
  console.log("\n=== sized products ===");
  {
    const r = await price([line(SHIRT, "M", 2)]);
    check("1. within stock passes", r.error, null);
    check("   priced from the catalogue, not the request", r.items[0].price_inr, 1500);
    check("   total is quantity × catalogue price", r.total, 3000);
  }
  {
    const r = await price([line(SHIRT, "M", 3)]);
    check("2. above stock fails", r.reason, "stock");
    check("   and says how many are left", r.error, "Only 2 left of Linen Shirt in M.");
  }
  {
    const r = await price([line(SHIRT, "L", 1)]);
    check("   a sold-out size says so", r.error, "Linen Shirt in L has just sold out.");
  }

  console.log("\n=== duplicate lines are one line ===");
  {
    const r = await price([line(SHIRT, "S", 2), line(SHIRT, "S", 2)]);
    check("3. 2 + 2 against a stock of 3 fails", r.reason, "stock");
    check("   naming the real shortfall", r.error, "Only 3 left of Linen Shirt in S.");
  }
  {
    const r = await price([line(SHIRT, "M", 1), line(SHIRT, "M", 1)]);
    check("4. 1 + 1 against a stock of 2 passes", r.error, null);
    check("   as one line", r.items.length, 1);
    check("   of quantity 2", r.items[0].quantity, 2);
    check("   totalled once", r.total, 3000);
  }
  {
    const r = await price([line(SHIRT, "S", 2), line(SHIRT, "M", 2)]);
    check("5. different sizes stay independent", r.error, null);
    check("   two lines", r.items.map((i) => `${i.size}×${i.quantity}`), ["S×2", "M×2"]);
  }
  {
    const r = await price([line(SHIRT, " M ", 1), line(SHIRT, "M", 1)]);
    check("   a size with stray whitespace is the same size", r.items.length, 1);
    check("   stored with the catalogue's label", r.items[0].size, "M");
  }
  {
    const r = await price([line(SHIRT, "m", 1)]);
    check("   but a label the product does not have is refused", r.reason, "invalid", "labels match exactly, as reserve_stock matches them");
  }

  console.log("\n=== sizeless products ===");
  {
    const r = await price([line(SAREE, "One Size", 2)]);
    check("6. within stock passes", r.error, null);
    check("   recorded as One Size", r.items[0].size, "One Size");
  }
  {
    const r = await price([line(SAREE, "One Size", 3)]);
    check("7. above stock fails — in_stock alone would have let this through", r.reason, "stock");
    check("   with the count", r.error, "Only 2 left of Zari Dhoti.");
  }
  {
    const r = await price([line(SAREE, "One Size", 1), line(SAREE, "", 1), line(SAREE, "Free Size", 1)]);
    check("8. duplicated sizeless lines are summed before the check", r.reason, "stock", "1 + 1 + 1 is 3, and there are 2");
  }
  {
    const r = await price([line(SAREE, "One Size", 1), line(SAREE, "", 1)]);
    check("   and two of them fit", r.error, null);
    check("   merged to one line of 2", r.items.map((i) => i.quantity), [2]);
  }
  {
    const r = await price([line(SAREE_GONE, "One Size", 1)]);
    check("   sold out says so", r.error, "Sold Saree has just sold out.");
  }
  {
    const r = await price([line(SAREE, "One Size", 1)], { ...catalogue, versions: [] });
    check("   no version count at all reads as none on the shelf", r.reason, "stock");
  }
  {
    const r = await price([line(SAREE, "One Size", 1)], { ...catalogue, versionsFail: true });
    check("   a failed count read cannot be priced, not waved through", r.reason, "pricing");
  }

  console.log("\n=== the request body is not the shelf ===");
  {
    const r = await price([line(SHIRT, "M", 99)]);
    check("9. a tampered quantity of 99 fails on stock", r.reason, "stock");
  }
  {
    const r = await price([line(SHIRT, "S", 50), line(SHIRT, "S", 49)]);
    check("   50 + 49 is still one line of 99 — and still short", r.reason, "stock");
  }
  {
    const r = await price([line(SHIRT, "S", 60), line(SHIRT, "S", 60)]);
    check("   60 + 60 is refused as invalid, not sized up", r.reason, "invalid");
  }
  for (const [label, q] of [["zero", 0], ["negative", -1], ["fractional", 1.5], ["NaN", NaN], ["string", "2" as unknown as number]] as const) {
    const r = await price([line(SHIRT, "M", q)]);
    check(`10. ${label} quantity is rejected`, r.reason, "invalid");
  }
  {
    const r = await price([{ ...line(SHIRT, "M", 1), id: "" }]);
    check("    a line with no id is rejected", r.reason, "invalid");
  }
  {
    const r = await price([line("p-nope", "One Size", 1)]);
    check("    an unknown product is refused", r.reason, "unavailable");
  }
  {
    const r = await price([]);
    check("    an empty cart is refused", r.reason, "empty");
  }
  {
    const r = await price([line(SHIRT, "", 1)]);
    check("    a sized product with no size chosen is refused", r.error, "Please choose a size for Linen Shirt.");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

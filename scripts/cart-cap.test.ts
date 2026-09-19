/**
 * The cart's quantity cap, exercised headlessly.
 *
 * This is the CONVENIENCE half of stock integrity: the product page says how
 * many are left, the cart carries that as a hint, and the stepper stops
 * there. None of it is believed by the server, which re-reads the shelf in
 * lib/checkoutPricing before any payment starts — scripts/checkout-pricing
 * covers that half. Here we check that the hint does what it should for an
 * honest customer, and never does more than that. Run:
 *
 *   npx tsx scripts/cart-cap.test.ts
 *
 * Exits non-zero on failure.
 */
// The store persists to localStorage, which Node does not have. An in-memory
// stand-in keeps zustand quiet; nothing here reads it back.
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

import type { CartItem } from "../lib/store";
import type { SupabaseClient } from "@supabase/supabase-js";

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

const DHOTI: Omit<CartItem, "quantity"> = {
  id: "p-dhoti",
  slug: "zari-dhoti",
  name: "Zari Dhoti",
  price_inr: 6000,
  image_url: null,
  size: "One Size",
  available: 2,
};

async function main() {
  // Loaded here, after the storage stub above — a static import would be
  // hoisted above it and the store would build itself with no storage.
  const { canIncrease, lineCeiling, useCartStore } = await import("../lib/store");
  const { priceCart } = await import("../lib/checkoutPricing");

  const store = () => useCartStore.getState();
  const reset = () => useCartStore.setState({ items: [], ownerId: null, isOpen: false });
  const line = (id = "p-dhoti", size = "One Size") =>
    store().items.find((i) => i.id === id && i.size === size);
  const qty = (id?: string, size?: string) => line(id, size)?.quantity ?? 0;

  console.log("\n=== the ceiling ===");
  check("a hinted line stops at the hint", lineCeiling({ available: 2 }), 2);
  check("no hint means no ceiling", lineCeiling({}), Infinity);
  check("a nonsense hint means no ceiling", lineCeiling({ available: NaN }), Infinity);
  check("a fractional hint rounds down", lineCeiling({ available: 2.7 }), 2);
  check("a negative hint is zero", lineCeiling({ available: -3 }), 0);
  check("+ is live below the hint", canIncrease({ quantity: 1, available: 2 }), true);
  check("12. + is dead at the hint", canIncrease({ quantity: 2, available: 2 }), false);
  check("+ is dead past a stale hint", canIncrease({ quantity: 3, available: 2 }), false);
  check("+ is live with no hint", canIncrease({ quantity: 50 }), true);

  console.log("\n=== addItem ===");
  reset();
  store().addItem(DHOTI, 2);
  check("adding 2 of 2 gives 2", qty(), 2);
  store().addItem(DHOTI, 2);
  check("11. adding 2 more does not climb past 2", qty(), 2, "the PDP said two, the cart does not invent a third");
  check("still one line", store().items.length, 1);
  store().addItem(DHOTI, 1);
  check("nor does adding 1 more", qty(), 2);

  reset();
  store().addItem(DHOTI, 5);
  check("a first add larger than the hint is clipped to it", qty(), 2);

  reset();
  store().addItem({ ...DHOTI, available: 0 }, 1);
  check("a sold-out hint adds nothing", store().items.length, 0);

  reset();
  store().addItem({ ...DHOTI, available: 3 }, 1);
  store().addItem({ ...DHOTI, available: 2 }, 1);
  check("the freshest hint replaces the old one", line()?.available, 2);
  check("and applies to the merge", qty(), 2);

  reset();
  store().addItem({ ...DHOTI, available: 1 }, 1);
  store().addItem({ ...DHOTI, available: 3 }, 2);
  check("a restock raises the ceiling", qty(), 3);

  console.log("\n=== the stepper ===");
  reset();
  store().addItem(DHOTI, 1);
  store().updateQuantity(DHOTI.id, DHOTI.size, 2);
  check("+ to 2 works", qty(), 2);
  store().updateQuantity(DHOTI.id, DHOTI.size, 3);
  check("12. + to 3 is refused — the customer-visible defect", qty(), 2);
  store().updateQuantity(DHOTI.id, DHOTI.size, 1);
  check("13. − still works", qty(), 1);
  store().updateQuantity(DHOTI.id, DHOTI.size, 0);
  check("    − to zero removes the line", store().items.length, 0);

  console.log("\n=== remove and re-add ===");
  reset();
  store().addItem(DHOTI, 2);
  store().removeItem(DHOTI.id, DHOTI.size);
  check("removed", store().items.length, 0);
  store().addItem(DHOTI, 2);
  store().addItem(DHOTI, 2);
  check("14. re-adding starts a fresh line, still capped", qty(), 2);

  console.log("\n=== sizes are separate lines ===");
  reset();
  const shirt = { ...DHOTI, id: "p-shirt", name: "Shirt" };
  store().addItem({ ...shirt, size: "M", available: 2 }, 2);
  store().addItem({ ...shirt, size: "L", available: 5 }, 2);
  store().addItem({ ...shirt, size: "M", available: 2 }, 1);
  check("M capped at its own stock", qty("p-shirt", "M"), 2);
  check("L unaffected", qty("p-shirt", "L"), 2);

  console.log("\n=== a stale cart, and who has the last word ===");
  // A cart written before hints existed, or one whose hint has gone stale.
  // The UI lets it be — it is not the cart's job to guess — and the server
  // says no when payment is attempted.
  reset();
  const legacy: CartItem = { ...DHOTI, quantity: 3 };
  delete (legacy as Partial<CartItem>).available;
  useCartStore.setState({ items: [legacy], ownerId: null });
  store().updateQuantity(DHOTI.id, DHOTI.size, 4);
  check("15. an unhinted line still steps up in the UI", qty(), 4, "there is nothing to cap against");
  store().addItem(DHOTI, 1);
  check("    a fresh hint does not cut it down", qty(), 4, "silently removing pieces is worse than a message at checkout");
  check("    but stops it climbing further", canIncrease(line()!), false);

  const shelf = {
    rpc: async () => ({
      data: [{ product_id: DHOTI.id, name: "Zari Dhoti", price_inr: 6000, cost_price_inr: null, sku: null, in_stock: true }],
      error: null,
    }),
    from: (table: string) => {
      const rows = table === "product_versions" ? [{ product_id: DHOTI.id, stock_quantity: 2 }] : [];
      const q: Record<string, unknown> = {
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
      };
      for (const m of ["select", "in", "eq", "order"]) q[m] = () => q;
      return q;
    },
  } as unknown as SupabaseClient;

  const r = await priceCart(store().items, shelf);
  check("    and the server refuses the stale cart at checkout", r.reason, "stock");
  check("    in words the page can show", r.error, "Only 2 left of Zari Dhoti.");
  const forged = await priceCart(
    store().items.map((i) => ({ ...i, available: 999, quantity: 3 })),
    shelf
  );
  check("    a forged hint changes nothing server-side", forged.reason, "stock", "`available` is never read by priceCart");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

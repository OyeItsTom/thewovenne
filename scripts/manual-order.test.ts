/**
 * The rules an in-person sale has to satisfy, exercised headlessly.
 *
 * These run in the browser and again in the route, and both paths need an admin
 * session to reach — so without this the first execution of the code would be a
 * real customer at a real stall. Run:
 *
 *   npx tsx scripts/manual-order.test.ts
 *
 * Exits non-zero on failure.
 */
import {
  findShortages,
  shortageMessage,
  validateCustomer,
  validateLines,
  type Availability,
  type ManualLine,
  type SellableProduct,
} from "../lib/manualOrder";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

function checkSays(name: string, actual: string | null, fragment: string) {
  const ok = typeof actual === "string" && actual.includes(fragment);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        expected a message containing ${JSON.stringify(fragment)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

// ── The catalogue under test ───────────────────
const SHIRT: SellableProduct = { id: "p-shirt", name: "Cotton Shirt", sizes: ["S", "M", "L"] };
const SAREE: SellableProduct = { id: "p-saree", name: "Mul Cotton Saree", sizes: [] };
const PRODUCTS = [SHIRT, SAREE];

const STOCK: Availability[] = [
  { productId: "p-shirt", size: "S", available: 2 },
  { productId: "p-shirt", size: "M", available: 0 },
  { productId: "p-shirt", size: "L", available: 5 },
  { productId: "p-saree", size: "", available: 1 },
];

const line = (patch: Partial<ManualLine> = {}): ManualLine => ({
  productId: "p-shirt",
  size: "L",
  quantity: 1,
  priceInr: 2400,
  ...patch,
});

console.log("\n=== who it was sold to ===");
check("name and email", validateCustomer({ name: "Asha", email: "asha@example.com", phone: "" }), null);
check("name and phone", validateCustomer({ name: "Asha", email: "", phone: "+91 98470 12345" }), null);
check("all three", validateCustomer({ name: "Asha", email: "a@b.co", phone: "9847012345" }), null);
checkSays(
  "no name at all",
  validateCustomer({ name: "", email: "asha@example.com", phone: "" }),
  "name goes on the invoice"
);
checkSays(
  "a single letter is not a name",
  validateCustomer({ name: "A", email: "asha@example.com", phone: "" }),
  "name goes on the invoice"
);
checkSays(
  "whitespace is not a name",
  validateCustomer({ name: "   ", email: "asha@example.com", phone: "" }),
  "name goes on the invoice"
);
checkSays(
  "no way to reach them",
  validateCustomer({ name: "Asha", email: "", phone: "" }),
  "no way to reach them"
);
checkSays(
  "an email with no @",
  validateCustomer({ name: "Asha", email: "asha.example.com", phone: "" }),
  "does not look right"
);
checkSays(
  "an email with no domain dot",
  validateCustomer({ name: "Asha", email: "asha@example", phone: "" }),
  "does not look right"
);
checkSays(
  "a phone too short to dial",
  validateCustomer({ name: "Asha", email: "", phone: "123" }),
  "too short"
);
// A number written the way people write numbers must still count.
check(
  "punctuation in the number is not a fault",
  validateCustomer({ name: "Asha", email: "", phone: "+91 (984) 701-2345" }),
  null
);
// The email is optional; a phone-only sale is a real one at a stall.
check(
  "phone only, no email",
  validateCustomer({ name: "Asha Menon", email: "  ", phone: "9847012345" }),
  null
);

console.log("\n=== the lines ===");
check("a sized product with a real size", validateLines([line()], PRODUCTS), null);
check("a product with no sizes and no size", validateLines([line({ productId: "p-saree", size: "" })], PRODUCTS), null);
check("nothing to sell", validateLines([], PRODUCTS), "Add at least one item.");
checkSays("a product that is not in the catalogue", validateLines([line({ productId: "ghost" })], PRODUCTS), "choose a product");
// THE BUG THIS FILE EXISTS FOR: "One Size" on a product with a size run.
checkSays(
  "a sized product left at One Size",
  validateLines([line({ size: "" })], PRODUCTS),
  "choose a size"
);
checkSays(
  "a sized product sold as One Size explicitly",
  validateLines([line({ size: "One Size" })], PRODUCTS),
  "not one of its sizes"
);
checkSays(
  "a size the product does not have",
  validateLines([line({ size: "XXL" })], PRODUCTS),
  "not one of its sizes"
);
checkSays(
  "a sizeless product given a size",
  validateLines([line({ productId: "p-saree", size: "M" })], PRODUCTS),
  "has no sizes"
);
checkSays("half an item", validateLines([line({ quantity: 1.5 })], PRODUCTS), "whole number");
checkSays("no items", validateLines([line({ quantity: 0 })], PRODUCTS), "whole number");
checkSays("a negative quantity", validateLines([line({ quantity: -2 })], PRODUCTS), "whole number");
checkSays("a negative price", validateLines([line({ priceInr: -1 })], PRODUCTS), "zero or more");
checkSays("a price that is not a number", validateLines([line({ priceInr: NaN })], PRODUCTS), "zero or more");
// Free is legitimate — a replacement handed over at a stall is a real line.
check("a price of zero", validateLines([line({ priceInr: 0 })], PRODUCTS), null);
// The message names the line, because a form with six rows needs to say which.
checkSays(
  "the message says which line",
  validateLines([line(), line({ size: "" })], PRODUCTS),
  "Line 2"
);

console.log("\n=== what is short ===");
check("inside the count", findShortages([line({ size: "L", quantity: 5 })], PRODUCTS, STOCK), []);
check(
  "one more than the count",
  findShortages([line({ size: "S", quantity: 3 })], PRODUCTS, STOCK),
  [{ productId: "p-shirt", name: "Cotton Shirt", size: "S", wanted: 3, available: 2 }]
);
check(
  "a size with none left",
  findShortages([line({ size: "M", quantity: 1 })], PRODUCTS, STOCK),
  [{ productId: "p-shirt", name: "Cotton Shirt", size: "M", wanted: 1, available: 0 }]
);
check(
  "a sizeless product inside its count",
  findShortages([line({ productId: "p-saree", size: "", quantity: 1 })], PRODUCTS, STOCK),
  []
);
check(
  "a sizeless product over its count",
  findShortages([line({ productId: "p-saree", size: "", quantity: 2 })], PRODUCTS, STOCK),
  [{ productId: "p-saree", name: "Mul Cotton Saree", size: "", wanted: 2, available: 1 }]
);
// THE ONE A PER-LINE CHECK WOULD WAVE THROUGH. Two lines of the same size, each
// inside the count, over it together — and reserve_stock would refuse the whole
// order at the till.
check(
  "two lines of the same size, over together",
  findShortages(
    [line({ size: "S", quantity: 1 }), line({ size: "S", quantity: 2 })],
    PRODUCTS,
    STOCK
  ),
  [{ productId: "p-shirt", name: "Cotton Shirt", size: "S", wanted: 3, available: 2 }]
);
check(
  "two lines of the same size, inside together",
  findShortages(
    [line({ size: "S", quantity: 1 }), line({ size: "S", quantity: 1 })],
    PRODUCTS,
    STOCK
  ),
  []
);
// Different sizes of one product are counted separately, as the shelf does.
check(
  "one size short, another fine",
  findShortages(
    [line({ size: "L", quantity: 2 }), line({ size: "M", quantity: 1 })],
    PRODUCTS,
    STOCK
  ),
  [{ productId: "p-shirt", name: "Cotton Shirt", size: "M", wanted: 1, available: 0 }]
);
// A product with no availability row at all — never published, so nothing to
// take. Reading it as unlimited is the failure that causes overselling.
check(
  "no count on record reads as none",
  findShortages([line({ size: "L", quantity: 1 })], PRODUCTS, []),
  [{ productId: "p-shirt", name: "Cotton Shirt", size: "L", wanted: 1, available: 0 }]
);

console.log("\n=== what the operator is told ===");
check(
  "a size with none left",
  shortageMessage(findShortages([line({ size: "M", quantity: 2 })], PRODUCTS, STOCK)),
  "Cotton Shirt (M): none left, 2 being sold"
);
check(
  "a size with some left",
  shortageMessage(findShortages([line({ size: "S", quantity: 3 })], PRODUCTS, STOCK)),
  "Cotton Shirt (S): only 2 left, 3 being sold"
);
check(
  "a sizeless product names no size",
  shortageMessage(
    findShortages([line({ productId: "p-saree", size: "", quantity: 4 })], PRODUCTS, STOCK)
  ),
  "Mul Cotton Saree: only 1 left, 4 being sold"
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

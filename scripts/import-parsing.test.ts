/**
 * Cell parsing for imports — the part that can corrupt data.
 *
 * The rule this exists to protect: a BLANK cell means "leave this alone", never
 * "set it to zero" or "set it to empty". An import that clears a field the
 * admin simply did not fill in is how a spreadsheet wipes a catalogue, and it
 * would look like a successful import while doing it.
 *
 *   npx tsx scripts/import-parsing.test.ts
 */
import { parseCell, IMPORT_KINDS, type ImportField } from "../lib/imports";

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

const field = (over: Partial<ImportField>): ImportField => ({
  key: "x",
  header: "Value",
  type: "text",
  required: false,
  example: "",
  ...over,
});

const money = field({ type: "money" });
const count = field({ type: "number" });
const date = field({ type: "date" });
const requiredMoney = field({ type: "money", required: true });

console.log("\n=== BLANK MEANS LEAVE ALONE — the rule that protects the data ===");
check("blank optional -> null, NOT 0", parseCell("", money), { value: null, error: null });
check("whitespace-only -> null", parseCell("   ", money), { value: null, error: null });
check("undefined -> null", parseCell(undefined, money), { value: null, error: null });
check("null -> null", parseCell(null, money), { value: null, error: null });
check("blank REQUIRED is an error, not a silent zero", parseCell("", requiredMoney), {
  value: null,
  error: "Value is required",
});
// A real zero is a real value and must survive — "this costs nothing" is a
// different statement from "I did not fill this in".
check("an explicit 0 is kept", parseCell("0", money), { value: 0, error: null });

console.log("\n=== what a spreadsheet actually hands over ===");
check("₹ and commas stripped", parseCell("₹1,900", money), { value: 1900, error: null });
check("stray spaces stripped", parseCell(" 2500 ", money), { value: 2500, error: null });
check("decimals kept", parseCell("78.50", money), { value: 78.5, error: null });
check("a real number passes through", parseCell(4500, money), { value: 4500, error: null });

console.log("\n=== refusals ===");
check("text in a money column", parseCell("about two thousand", money), {
  value: null,
  error: "Value is not a number",
});
check("negative money", parseCell("-50", money), { value: null, error: "Value cannot be negative" });
check("fractional stock", parseCell("3.5", count), {
  value: null,
  error: "Value must be a whole number",
});
check("nonsense date", parseCell("the third of never", date), {
  value: null,
  error: "Value is not a date",
});

console.log("\n=== dates arrive two different ways ===");
check("a Date object from a formatted cell", parseCell(new Date("2026-08-01T00:00:00Z"), date), {
  value: "2026-08-01",
  error: null,
});
check("a typed string from a text cell", parseCell("2026-08-01", date), {
  value: "2026-08-01",
  error: null,
});

console.log("\n=== every declared field is coherent ===");
for (const kind of IMPORT_KINDS) {
  const keys = new Set(kind.fields.map((f) => f.key));
  if (keys.size !== kind.fields.length) {
    console.log(`  FAIL  ${kind.id} has duplicate field keys`);
    fail++;
    continue;
  }
  const noExample = kind.fields.filter((f) => f.required && f.example === "");
  if (noExample.length > 0) {
    console.log(`  FAIL  ${kind.id}: required fields with no example — ${noExample.map((f) => f.header).join(", ")}`);
    fail++;
    continue;
  }
  console.log(`  PASS  ${kind.id}: ${kind.fields.length} fields, unique keys, examples on every required one`);
  pass++;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

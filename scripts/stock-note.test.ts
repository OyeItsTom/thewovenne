/**
 * What the page is allowed to say about availability.
 *
 *   npx tsx scripts/stock-note.test.ts
 *
 * These are the rules that used to live as inline ternaries in three components,
 * which is how a card came to say "Only 5 left" about a product whose own page
 * said nothing. Pure functions, so the wording can be pinned — and the wording
 * IS the feature here: the difference between an elegant nudge and a cheap one is
 * entirely in what the string says.
 */
import { LOW_STOCK_THRESHOLD, stockNote, stockState } from "../lib/stock";
import type { ProductSize } from "../lib/sizes";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const size = (label: string, stock: number): ProductSize => ({
  id: label,
  label,
  sort_order: 0,
  stock_quantity: stock,
});

const note = (stock: number, sizes: ProductSize[] = []) => stockNote(stockState(stock, sizes));

console.log("\n=== a piece with no sizes ===");
t("plenty says nothing at all", note(10) === null,
  "silence on most products is what makes the notice mean something");
t("three is a shelf, not a nudge", note(3) === null, `threshold is ${LOW_STOCK_THRESHOLD}`);
t("two is a decision", note(2) === "Almost gone — only two left", String(note(2)));
t("one, in words rather than numerals", note(1) === "Almost gone — only one left", String(note(1)));
t("zero is sold out", note(0) === "Sold out");
t("negative stock does not become a strange sentence", note(-4) === "Sold out",
  "a bad row must not read as 'only -4 left'");

console.log("\n=== a sized piece ===");
t("all sizes healthy says nothing",
  note(0, [size("S", 5), size("M", 4)]) === null,
  "and note the product's own stock column is 0 here — sizes win");
t("one low size among healthy ones",
  note(0, [size("S", 5), size("M", 2)]) === "Almost gone in some sizes", String(note(0, [size("S", 5), size("M", 2)])));
t("one size left, and it is low",
  note(0, [size("S", 0), size("M", 2)]) === "Almost gone — only two left",
  "with a single buyable size the number is honest again");
t("one size left with plenty says nothing",
  note(0, [size("S", 0), size("M", 8)]) === null);
t("every size gone is sold out",
  note(0, [size("S", 0), size("M", 0)]) === "Sold out");
t("a sized product is never rescued by its own stock column",
  note(99, [size("S", 0), size("M", 0)]) === "Sold out",
  "10 in the column and nothing in any size is sold out");

console.log("\n=== the shape underneath ===");
const mixed = stockState(0, [size("S", 0), size("M", 2), size("L", 7)]);
t("sold-out sizes are listed", mixed.soldOutSizes.join(",") === "S", mixed.soldOutSizes.join(","));
t("low-but-buyable sizes are listed", mixed.lowSizes.join(",") === "M", mixed.lowSizes.join(","));
t("a sold-out size is not also counted as low",
  !mixed.lowSizes.includes("S"), "zero is gone, not nearly gone");
t("remaining is null when several sizes are buyable", mixed.remaining === null,
  "a total across sizes is a number nobody can buy");
t("not sold out while anything is buyable", mixed.soldOut === false);

console.log("\n=== the tone, as rules ===");
const everyNote = [
  note(2), note(1), note(0),
  note(0, [size("S", 5), size("M", 2)]),
  note(0, [size("S", 0), size("M", 0)]),
].filter((n): n is string => n !== null);

t("nothing shouts", everyNote.every((n) => n === n.replace(/!/g, "")), everyNote.join(" / "));
t("nothing tells anybody to hurry",
  everyNote.every((n) => !/hurry|now|quick|last chance|don't miss/i.test(n)));
t("nothing counts down in numerals",
  everyNote.every((n) => !/\d/.test(n)),
  "digits in a stock line read as a ticker");
t("sold out is two words and no apology",
  note(0) === "Sold out", "not 'Out of Stock', which is the language the button now uses too");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

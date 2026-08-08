/**
 * The one thing an .xlsx export must get right: a total has to be a NUMBER a
 * formula can reach, and a date has to be a DATE Excel can sort.
 *
 * PostgREST hands back numeric columns as strings, so this is not theoretical —
 * without coercion every money column would land as text, the file would look
 * completely correct, and every SUM in it would return zero.
 *
 * Writes a real workbook and reads it back, because asserting on toCell() alone
 * would only prove my own function agrees with itself.
 *
 *   npx tsx scripts/export-cells.test.ts
 */
import ExcelJS from "exceljs";
import { NUMBER_FORMAT, toCell, type ExportColumn } from "../lib/exports";

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

const columns: ExportColumn[] = [
  { key: "name", label: "Name", type: "text", default: true },
  { key: "amount", label: "Amount", type: "money", default: true },
  { key: "qty", label: "Qty", type: "number", default: true },
  { key: "margin", label: "Margin %", type: "percent", default: true },
  { key: "when", label: "Date", type: "date", default: true },
];

// Deliberately the shapes PostgREST actually returns: money as a STRING,
// numbers as strings, an ISO timestamp, and nulls.
const source = {
  name: "Kerala Kasavu Saree",
  amount: "5000.00",
  qty: "3",
  margin: "62.5",
  when: "2026-08-08T10:12:00Z",
};

console.log("\n=== toCell turns PostgREST strings into real types ===");
check("money string -> number", toCell(source.amount, columns[1]), 5000);
check("number string -> number", toCell(source.qty, columns[2]), 3);
check("percent 62.5 -> 0.625 (Excel multiplies by 100)", toCell(source.margin, columns[3]), 0.625);
check("text stays text", toCell(source.name, columns[0]), "Kerala Kasavu Saree");
check("null stays null", toCell(null, columns[1]), null);
check("undefined stays null", toCell(undefined, columns[1]), null);
check("unparseable money -> null, never 0", toCell("not a number", columns[1]), null);
check("boolean -> Yes/No", toCell(true, columns[0]), "Yes");
console.log(
  `  ${toCell(source.when, columns[4]) instanceof Date ? "PASS" : "FAIL"}  ISO string -> Date object`
);
toCell(source.when, columns[4]) instanceof Date ? pass++ : fail++;

async function main() {
  console.log("\n=== a real workbook, written and read back ===");
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Test");
  sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: 20 }));
  sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, toCell(source[c.key as keyof typeof source], c)])));
  columns.forEach((c, i) => {
    const f = NUMBER_FORMAT[c.type];
    if (f) sheet.getColumn(i + 1).numFmt = f;
  });

  const buffer = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buffer as ArrayBuffer);
  const row = back.getWorksheet("Test")!.getRow(2);

  check("amount cell is a number in the file", typeof row.getCell(2).value, "number");
  check("amount value survives the round trip", row.getCell(2).value, 5000);
  check("qty cell is a number", typeof row.getCell(3).value, "number");
  check("margin stored as a fraction", row.getCell(4).value, 0.625);
  console.log(
    `  ${row.getCell(5).value instanceof Date ? "PASS" : "FAIL"}  date cell is a Date in the file`
  );
  row.getCell(5).value instanceof Date ? pass++ : fail++;
  check("text cell is text", typeof row.getCell(1).value, "string");

  // The formats are what make it readable; the types are what make it usable.
  check("money column carries the rupee format", back.getWorksheet("Test")!.getColumn(2).numFmt, "₹#,##,##0.00");

  // The proof that matters: Excel can add it up.
  const total = [row.getCell(2).value, row.getCell(3).value]
    .map(Number)
    .reduce((a, b) => a + b, 0);
  check("cells are summable (5000 + 3)", total, 5003);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

void main();

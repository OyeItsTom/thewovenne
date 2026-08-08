/**
 * What can be imported, and what a valid row looks like.
 *
 * ONE DEFINITION for the template, the validator and the committer. A template
 * whose headers disagree with the parser is a file the admin fills in
 * correctly and cannot upload, and they would have no way of knowing why.
 *
 * NOTHING HERE DELETES. Every import either inserts a new row or updates named
 * fields on an existing one. A blank cell means "leave this alone", never "set
 * it to empty" — an import that clears a field the admin simply did not fill in
 * is how a spreadsheet quietly wipes a catalogue.
 */

export type ImportFieldType = "text" | "number" | "money" | "date";

export interface ImportField {
  key: string;
  header: string;
  type: ImportFieldType;
  required: boolean;
  /** Shown in the example row, and in the picker's help text. */
  example: string;
  hint?: string;
}

export interface ImportKind {
  id: string;
  label: string;
  blurb: string;
  /** What an existing row is matched on. */
  matchOn: string;
  fields: ImportField[];
  /** Said plainly above the upload button, before anything is chosen. */
  safety: string;
}

export const IMPORT_KINDS: ImportKind[] = [
  {
    id: "products",
    label: "Products",
    blurb: "Update prices, costs and stock in bulk, or add new pieces",
    matchOn: "SKU",
    safety:
      "Matched on SKU. A row whose SKU exists updates that product; a row with a new SKU creates one. Everything lands as a DRAFT and appears in Review & Publish — nothing reaches the shop until you publish it.",
    fields: [
      { key: "sku", header: "SKU", type: "text", required: true, example: "KASAVU-SAREE-01", hint: "Matched against existing products" },
      { key: "name", header: "Name", type: "text", required: false, example: "Kerala Kasavu Saree", hint: "Required only for a new product" },
      { key: "cost_price_inr", header: "Cost price", type: "money", required: false, example: "1900" },
      { key: "price_inr", header: "Selling price", type: "money", required: false, example: "4500" },
      { key: "stock_quantity", header: "Stock", type: "number", required: false, example: "8" },
      { key: "hsn_code", header: "HSN code", type: "text", required: false, example: "" },
    ],
  },
  {
    id: "courier_costs",
    label: "Courier costs",
    blurb: "What each parcel actually cost, from a Shiprocket export",
    matchOn: "Invoice number or order reference",
    safety:
      "Matched on the invoice number or order reference. Only the courier cost is written; nothing else on the order is touched. This is what makes the shipping line in the P&L real rather than an estimate.",
    fields: [
      { key: "order_ref", header: "Order reference", type: "text", required: true, example: "WOV-2026-0001", hint: "Invoice number, or the Razorpay order id" },
      { key: "courier_actual_cost_inr", header: "Courier cost", type: "money", required: true, example: "78.50" },
    ],
  },
  {
    id: "expenses",
    label: "Expenses",
    blurb: "A month of costs at once",
    matchOn: "Nothing — every row is added",
    safety:
      "Every row is added as a new expense. Nothing is matched or updated, so uploading the same file twice records everything twice.",
    fields: [
      { key: "incurred_on", header: "Date", type: "date", required: true, example: "2026-08-01" },
      { key: "category", header: "Category", type: "text", required: true, example: "shipping", hint: "shipping, marketing, software, packaging, rent, salaries or misc" },
      { key: "amount_inr", header: "Amount", type: "money", required: true, example: "1200" },
      { key: "description", header: "Description", type: "text", required: false, example: "August courier retainer" },
      { key: "vendor", header: "Vendor", type: "text", required: false, example: "Shiprocket" },
      { key: "reference", header: "Reference", type: "text", required: false, example: "INV-4417" },
    ],
  },
];

export function importKindById(id: string): ImportKind | undefined {
  return IMPORT_KINDS.find((k) => k.id === id);
}

/** One parsed row, with whatever is wrong with it. */
export interface ParsedRow {
  /** 1-based row number in the uploaded sheet, so an error names the row. */
  row: number;
  values: Record<string, string | number | null>;
  errors: string[];
  /** What committing this row would do. */
  action: "create" | "update" | "skip";
  /** Human-readable summary of the change, shown in the preview. */
  summary: string;
}

export interface ImportPreview {
  kind: string;
  rows: ParsedRow[];
  counts: { create: number; update: number; skip: number; errors: number };
}

/**
 * Read one cell into the shape the field expects.
 *
 * Returns null for blank, which every caller must treat as "leave alone" rather
 * than "set to empty" — see the module header.
 */
export function parseCell(
  raw: unknown,
  field: ImportField
): { value: string | number | null; error: string | null } {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return field.required
      ? { value: null, error: `${field.header} is required` }
      : { value: null, error: null };
  }

  const text = String(raw).trim();

  if (field.type === "money" || field.type === "number") {
    // Spreadsheets hand back ₹, commas and stray spaces from a pasted column.
    // Stripping them is not leniency for its own sake: the alternative is
    // rejecting a file that looks completely correct to the person who made it.
    const cleaned = text.replace(/[₹,\s]/g, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return { value: null, error: `${field.header} is not a number` };
    if (n < 0) return { value: null, error: `${field.header} cannot be negative` };
    if (field.type === "number" && !Number.isInteger(n)) {
      return { value: null, error: `${field.header} must be a whole number` };
    }
    return { value: n, error: null };
  }

  if (field.type === "date") {
    // ExcelJS hands back a real Date for a date-formatted cell and a string for
    // a text one. Both have to work — an admin who typed the date rather than
    // formatting the column has not made a mistake.
    const date = raw instanceof Date ? raw : new Date(text);
    if (Number.isNaN(date.getTime())) {
      return { value: null, error: `${field.header} is not a date` };
    }
    return { value: date.toISOString().slice(0, 10), error: null };
  }

  return { value: text, error: null };
}

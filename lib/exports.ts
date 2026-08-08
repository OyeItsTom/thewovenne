/**
 * What can be exported, and which columns each dataset offers.
 *
 * ONE DEFINITION, READ BY BOTH SIDES. The column picker renders from this and
 * the route builds the sheet from it, so a column cannot appear in the UI that
 * the file does not produce — or worse, be ticked and silently absent.
 *
 * Types are declared here rather than inferred at write time. Excel decides
 * whether a cell is a number by what it is given, and "5000" as text is a cell
 * no formula will add up — which defeats the point of exporting to a
 * spreadsheet at all.
 */

export type ColumnType = "text" | "number" | "money" | "date" | "datetime" | "percent";

export interface ExportColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** Ticked when the picker first opens. */
  default: boolean;
}

export interface ExportDataset {
  id: string;
  label: string;
  blurb: string;
  /** Whether a date range applies, and which field it filters. */
  dateField: string | null;
  columns: ExportColumn[];
}

const col = (
  key: string,
  label: string,
  type: ColumnType = "text",
  onByDefault = true
): ExportColumn => ({ key, label, type, default: onByDefault });

export const EXPORT_DATASETS: ExportDataset[] = [
  {
    id: "orders",
    label: "Orders & line items",
    // One row per LINE, not per order. An order with three pieces is three
    // rows with the order's own fields repeated — which is what a pivot table
    // or a SUMIF needs. One row per order with the items crushed into a text
    // cell reads fine and cannot be analysed.
    blurb: "One row per item sold, with its order's details repeated",
    dateField: "created_at",
    columns: [
      col("invoice_number", "Invoice no."),
      col("order_ref", "Order reference"),
      col("created_at", "Order date", "date"),
      col("customer_name", "Customer"),
      col("customer_email", "Email"),
      col("customer_phone", "Phone", "text", false),
      col("item_name", "Item"),
      col("item_sku", "SKU"),
      col("item_size", "Size"),
      col("item_quantity", "Qty", "number"),
      col("item_price_inr", "Unit price", "money"),
      col("item_line_total", "Line total", "money"),
      col("item_cost_inr", "Unit cost", "money", false),
      col("order_total_inr", "Order total", "money"),
      col("shipping_cost_inr", "Delivery charged", "money", false),
      col("coupon_code", "Discount code", "text", false),
      col("coupon_discount_inr", "Code discount", "money", false),
      col("loyalty_discount_inr", "Loyalty discount", "money", false),
      col("cogs_inr", "Order cost of goods", "money", false),
      col("gateway_fee_inr", "Gateway fee", "money", false),
      col("courier_actual_cost_inr", "Courier cost", "money", false),
      col("status", "Fulfilment"),
      col("payment_status", "Payment"),
    ],
  },
  {
    id: "products",
    label: "Products",
    blurb: "Catalogue with cost, price and margin",
    dateField: null,
    columns: [
      col("sku", "SKU"),
      col("name", "Name"),
      col("category", "Category"),
      col("cost_price_inr", "Cost price", "money"),
      col("price_inr", "Selling price", "money"),
      col("margin_inr", "Margin", "money"),
      col("margin_pct", "Margin %", "percent"),
      col("stock_quantity", "Stock", "number"),
      col("sizes", "Stock by size"),
      col("fabric", "Fabric", "text", false),
      col("colour", "Colour", "text", false),
      col("is_active", "Active", "text", false),
      col("hsn_code", "HSN code", "text", false),
    ],
  },
  {
    id: "customers",
    label: "Customers",
    blurb: "Who buys, how often, and who may be emailed",
    dateField: null,
    columns: [
      col("full_name", "Name"),
      col("email", "Email"),
      col("created_at", "Signed up", "date"),
      col("order_count", "Orders", "number"),
      col("total_spend_inr", "Total spend", "money"),
      col("last_order_at", "Last order", "date", false),
      // Never off by default and never silently dropped: exporting a customer
      // list without saying who consented is how a list gets used for
      // marketing it was never allowed to be used for.
      col("marketing_consent", "Marketing consent"),
    ],
  },
  {
    id: "coupons",
    label: "Discount codes",
    // One row per CODE, not per redemption — the opposite grain to orders, and
    // deliberately so. The question this answers is "did that promotion work?",
    // which needs the codes that were never used to appear at all. A row per
    // redemption would silently omit every code that got no traction, which is
    // exactly the result worth knowing.
    blurb: "Every code with its usage — including the ones nobody used",
    dateField: null,
    columns: [
      col("code", "Code"),
      col("discount", "Discount"),
      col("min_order_inr", "Minimum order", "money", false),
      col("expires_at", "Expires", "date"),
      col("max_uses", "Use limit", "number", false),
      col("times_used", "Times used", "number"),
      col("total_discounted_inr", "Total discounted", "money"),
      col("state", "Status"),
      col("once_per_customer", "One per customer", "text", false),
      col("created_at", "Created", "date", false),
      col("order_refs", "Orders used on", "text", false),
    ],
  },
  {
    id: "reviews",
    label: "Reviews",
    blurb: "What customers wrote, and whether it is visible",
    dateField: "created_at",
    columns: [
      col("created_at", "Date", "date"),
      col("product_name", "Product"),
      col("rating", "Rating", "number"),
      col("body", "Review"),
      col("author", "Customer"),
      col("author_email", "Email", "text", false),
      col("visibility", "Visibility"),
      col("hidden_at", "Hidden on", "date", false),
    ],
  },
  {
    id: "stock_movements",
    label: "Stock movements",
    blurb: "Every change in stock, with the reason it moved",
    dateField: "created_at",
    columns: [
      col("created_at", "When", "datetime"),
      col("product_name", "Product"),
      col("sku", "SKU", "text", false),
      col("size_label", "Size"),
      col("delta", "Change", "number"),
      col("reason", "Reason"),
      col("note", "Note"),
      col("order_ref", "Order", "text", false),
    ],
  },
  {
    id: "expenses",
    label: "Expenses",
    blurb: "Business costs, by category",
    dateField: "incurred_on",
    columns: [
      col("incurred_on", "Date", "date"),
      col("category", "Category"),
      col("description", "Description"),
      col("vendor", "Vendor"),
      col("reference", "Reference", "text", false),
      col("amount_inr", "Amount", "money"),
      col("tax_inr", "GST", "money", false),
    ],
  },
];

export function datasetById(id: string): ExportDataset | undefined {
  return EXPORT_DATASETS.find((d) => d.id === id);
}

/** Default tick state for a dataset's picker. */
export function defaultColumns(dataset: ExportDataset): string[] {
  return dataset.columns.filter((c) => c.default).map((c) => c.key);
}

/**
 * Excel number formats per column type.
 *
 * ₹ with Indian digit grouping — Excel's own #,##,##0 handles lakhs and crores,
 * which a plain #,##0 does not.
 */
export const NUMBER_FORMAT: Partial<Record<ColumnType, string>> = {
  money: '₹#,##,##0.00',
  number: "#,##0",
  percent: "0.0%",
  date: "dd mmm yyyy",
  datetime: "dd mmm yyyy hh:mm",
};

/**
 * Give Excel a real number or a real date wherever the column says so.
 *
 * The entire point of .xlsx over CSV is that a total is a number a formula can
 * reach. PostgREST returns numeric columns as STRINGS ("5000.00"), and a string
 * in a cell is text no SUM will touch — the export would look right and be
 * useless. Kept here rather than in the route so it can be tested without a
 * request, a session or a database.
 */
export function toCell(value: unknown, column: ExportColumn): unknown {
  if (value === null || value === undefined) return null;

  if (column.type === "money" || column.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (column.type === "percent") {
    const n = Number(value);
    // Excel's percent format multiplies by 100, so 42.5% is stored as 0.425.
    return Number.isFinite(n) ? n / 100 : null;
  }
  if (column.type === "date" || column.type === "datetime") {
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

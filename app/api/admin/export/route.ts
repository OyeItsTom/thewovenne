import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createRSCClient } from "@/lib/supabaseRSC";
import {
  datasetById,
  NUMBER_FORMAT,
  toCell,
  type ExportDataset,
} from "@/lib/exports";
import { categoryLabel, financialYear } from "@/lib/expenses";

/**
 * Excel export.
 *
 * THE CALLER'S OWN SESSION, NEVER THE SERVICE KEY. Every query here runs as
 * whoever asked, so RLS decides what comes back — the same rule as the invoice
 * route. Using the service client would bypass RLS and quietly export rows the
 * admin is not entitled to; it would also break the reporting functions, which
 * gate on is_admin() internally and return EMPTY rather than erroring for a
 * service-role caller. A P&L export of all zeroes that looks like a quiet
 * month is the worst possible failure here.
 *
 * Node runtime — ExcelJS needs it.
 */
export const runtime = "nodejs";

interface ExportRequest {
  dataset: string;
  columns: string[];
  from?: string;
  to?: string;
  /** The year-end bundle: several sheets in one file. */
  bundle?: "financial-year";
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ExportRequest;
  const supabase = createRSCClient();

  // Cheap, explicit gate before any work. RLS would refuse the rows anyway,
  // but an empty spreadsheet is a worse answer than a refusal.
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) {
    return new NextResponse("Not found", { status: 404 });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "THE WOVENNE";
  workbook.created = new Date();

  try {
    if (body.bundle === "financial-year") {
      const fy = financialYear(body.from ? new Date(body.from) : new Date());
      await addSheet(workbook, supabase, "orders", null, fy.from, fy.to);
      await addSheet(workbook, supabase, "expenses", null, fy.from, fy.to);
      await addProfitAndLossSheet(workbook, supabase, fy.from, fy.to);
      return send(workbook, `wovenne-${fy.label.replace(/[^\w-]/g, "")}.xlsx`);
    }

    const dataset = datasetById(body.dataset);
    if (!dataset) {
      return NextResponse.json({ error: "Unknown dataset" }, { status: 400 });
    }
    await addSheet(workbook, supabase, dataset.id, body.columns, body.from, body.to);
    const stamp = new Date().toISOString().slice(0, 10);
    return send(workbook, `wovenne-${dataset.id}-${stamp}.xlsx`);
  } catch (e) {
    console.error("export failed:", e);
    return NextResponse.json(
      { error: "Could not build that export. Please try again." },
      { status: 500 }
    );
  }
}

async function send(workbook: ExcelJS.Workbook, filename: string) {
  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Contains customer and financial data, generated per caller.
      "Cache-Control": "private, no-store",
    },
  });
}

type Client = ReturnType<typeof createRSCClient>;
type Row = Record<string, unknown>;

async function addSheet(
  workbook: ExcelJS.Workbook,
  supabase: Client,
  datasetId: string,
  chosen: string[] | null,
  from?: string,
  to?: string
) {
  const dataset = datasetById(datasetId);
  if (!dataset) return;

  // A bundle sheet takes every column; a picked export takes what was ticked,
  // in the dataset's own order so the file reads the same way every time.
  const columns = chosen
    ? dataset.columns.filter((c) => chosen.includes(c.key))
    : dataset.columns;
  if (columns.length === 0) return;

  const rows = await fetchRows(supabase, dataset, from, to);
  const sheet = workbook.addWorksheet(dataset.label.slice(0, 31));

  sheet.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.min(Math.max(c.label.length + 4, 12), 40),
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF0EAD6" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  for (const row of rows) {
    sheet.addRow(
      Object.fromEntries(columns.map((c) => [c.key, toCell(row[c.key], c)]))
    );
  }

  // Formats are applied per COLUMN rather than per cell: a numeric cell with no
  // format still adds up, but reads as a bare 5000 where the rest of the sheet
  // says ₹5,000.00.
  columns.forEach((c, i) => {
    const format = NUMBER_FORMAT[c.type];
    if (format) sheet.getColumn(i + 1).numFmt = format;
  });
}

async function fetchRows(
  supabase: Client,
  dataset: ExportDataset,
  from?: string,
  to?: string
): Promise<Row[]> {
  if (dataset.id === "orders") return fetchOrderLines(supabase, from, to);
  if (dataset.id === "products") return fetchProducts(supabase);
  if (dataset.id === "customers") return fetchCustomers(supabase);
  if (dataset.id === "expenses") return fetchExpenses(supabase, from, to);
  return [];
}

async function fetchOrderLines(supabase: Client, from?: string, to?: string): Promise<Row[]> {
  let query = supabase
    .from("orders")
    .select(
      "id, invoice_number, razorpay_order_id, created_at, customer_name, customer_email, " +
        "customer_phone, items, total_inr, shipping_cost_inr, cogs_inr, coupon_code, " +
        "coupon_discount_inr, loyalty_discount_inr, gateway_fee_inr, courier_actual_cost_inr, " +
        "status, payment_status"
    )
    .order("created_at", { ascending: false });

  if (from) query = query.gte("created_at", from);
  // Inclusive of the closing day: a range ending 31 March must contain the
  // orders placed on 31 March.
  if (to) query = query.lt("created_at", nextDay(to));

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const out: Row[] = [];
  for (const order of (data ?? []) as unknown as Row[]) {
    const items = Array.isArray(order.items) ? (order.items as Row[]) : [];
    const base = {
      invoice_number: order.invoice_number,
      order_ref: order.razorpay_order_id ?? order.id,
      created_at: order.created_at,
      customer_name: order.customer_name,
      customer_email: order.customer_email,
      customer_phone: order.customer_phone,
      order_total_inr: order.total_inr,
      shipping_cost_inr: order.shipping_cost_inr,
      coupon_code: order.coupon_code,
      coupon_discount_inr: order.coupon_discount_inr,
      loyalty_discount_inr: order.loyalty_discount_inr,
      cogs_inr: order.cogs_inr,
      gateway_fee_inr: order.gateway_fee_inr,
      courier_actual_cost_inr: order.courier_actual_cost_inr,
      status: order.status,
      payment_status: order.payment_status,
    };

    if (items.length === 0) {
      // An order with no line items still belongs in the file — losing it
      // would make the sheet's total disagree with the P&L's.
      out.push({ ...base, item_name: "(no items recorded)" });
      continue;
    }
    for (const item of items) {
      const qty = Number(item.quantity ?? 0);
      const price = Number(item.price_inr ?? 0);
      out.push({
        ...base,
        item_name: item.name,
        item_sku: item.sku ?? null,
        item_size: item.size,
        item_quantity: qty,
        item_price_inr: price,
        item_line_total: qty * price,
        item_cost_inr: item.cost_price_inr ?? null,
      });
    }
  }
  return out;
}

async function fetchProducts(supabase: Client): Promise<Row[]> {
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, sku, name, price_inr, cost_price_inr, stock_quantity, fabric, colour, is_active, hsn_code, categories(name)"
    )
    .order("name");
  if (error) throw new Error(error.message);

  const { data: sizes } = await supabase
    .from("product_sizes")
    .select("product_id, label, stock_quantity")
    .order("sort_order");

  const bySize = new Map<string, string[]>();
  for (const s of (sizes ?? []) as unknown as Row[]) {
    const key = String(s.product_id);
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key)!.push(`${s.label}: ${s.stock_quantity}`);
  }

  return ((data ?? []) as unknown as Row[]).map((p) => {
    const price = Number(p.price_inr ?? 0);
    const cost = p.cost_price_inr === null ? null : Number(p.cost_price_inr);
    return {
      sku: p.sku,
      name: p.name,
      category: (p.categories as { name?: string } | null)?.name ?? null,
      cost_price_inr: cost,
      price_inr: price,
      // Null cost means unknown margin, not 100%. Reporting a full margin for
      // a piece nobody has costed is the same overstatement the P&L warns about.
      margin_inr: cost === null ? null : price - cost,
      margin_pct: cost === null || price <= 0 ? null : ((price - cost) / price) * 100,
      stock_quantity: p.stock_quantity,
      sizes: bySize.get(String(p.id))?.join(", ") ?? null,
      fabric: p.fabric,
      colour: p.colour,
      is_active: p.is_active,
      hsn_code: p.hsn_code,
    };
  });
}

async function fetchCustomers(supabase: Client): Promise<Row[]> {
  // The same RPC the Customers screen reads, so the export and the screen
  // cannot disagree about who exists or what they have spent.
  const { data, error } = await supabase.rpc("admin_customers");
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Row[]).map((c) => ({
    ...c,
    marketing_consent: c.marketing_consent ? "Yes" : "No",
  }));
}

async function fetchExpenses(supabase: Client, from?: string, to?: string): Promise<Row[]> {
  let query = supabase
    .from("expenses")
    .select("incurred_on, category, description, vendor, reference, amount_inr, tax_inr")
    .order("incurred_on", { ascending: false });
  if (from) query = query.gte("incurred_on", from);
  if (to) query = query.lte("incurred_on", to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Row[]).map((e) => ({
    ...e,
    category: categoryLabel(String(e.category)),
  }));
}

/**
 * The P&L as a readable statement rather than a table of records.
 *
 * Built from the same profit_and_loss() the screen calls, so the bundle handed
 * to an accountant and the figures on screen are the same numbers from the
 * same source.
 */
async function addProfitAndLossSheet(
  workbook: ExcelJS.Workbook,
  supabase: Client,
  from: string,
  to: string
) {
  const { data, error } = await supabase.rpc("profit_and_loss", {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);

  const pl = data as {
    revenue: { goods: number; delivery: number; total: number; orders: number };
    discounts_given: { coupons: number; loyalty: number; total: number };
    cogs: number;
    gross_profit: number;
    operating_costs: {
      gateway_fee: number;
      gateway_tax: number;
      courier: number;
      expenses: { category: string; amount: number }[];
      total: number;
    };
    net_profit: number;
    gaps: Record<string, number>;
  };

  const sheet = workbook.addWorksheet("Profit & Loss");
  sheet.columns = [
    { header: "", key: "label", width: 42 },
    { header: "", key: "amount", width: 18 },
  ];

  const line = (label: string, amount?: number | null, bold = false) => {
    const row = sheet.addRow({ label, amount: amount ?? null });
    if (bold) row.font = { bold: true };
    return row;
  };

  line(`Profit & Loss — ${from} to ${to}`, null, true);
  line("");
  line("REVENUE", null, true);
  line("Goods", pl.revenue.goods);
  line("Delivery charged", pl.revenue.delivery);
  line(`Total revenue (${pl.revenue.orders} orders)`, pl.revenue.total, true);
  line("");
  line("COST OF GOODS SOLD", null, true);
  line("Cost of goods", -pl.cogs);
  line("Gross profit", pl.gross_profit, true);
  line("");
  line("OPERATING COSTS", null, true);
  line("Payment gateway fee", -pl.operating_costs.gateway_fee);
  line("Gateway GST", -pl.operating_costs.gateway_tax);
  line("Courier (per order)", -pl.operating_costs.courier);
  for (const e of pl.operating_costs.expenses) {
    line(categoryLabel(e.category), -Number(e.amount));
  }
  line("Total operating costs", -pl.operating_costs.total, true);
  line("");
  line("NET PROFIT", pl.net_profit, true);
  line("");
  // Carried into the file deliberately. A spreadsheet emailed to an accountant
  // outlives the screen that warned about it, and these gaps only ever flatter.
  line("NOTES", null, true);
  line(
    `Discounts given (already deducted from revenue): ${pl.discounts_given.total}`
  );
  for (const [key, count] of Object.entries(pl.gaps)) {
    if (Number(count) > 0) {
      line(`Incomplete data — ${key.replace(/_/g, " ")}: ${count}`);
    }
  }

  sheet.getColumn(2).numFmt = NUMBER_FORMAT.money!;
}

function nextDay(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

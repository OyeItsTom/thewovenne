import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import InvoiceDocument from "@/components/invoice/InvoiceDocument";
import { buildInvoice, INVOICE_SELECT } from "@/lib/invoice";
import { sendEmail } from "@/lib/email";
import { OFFLINE_METHODS, type PaymentMethod } from "@/lib/paymentMethods";
import {
  findShortages,
  shortageMessage,
  validateCustomer,
  validateLines,
  type Availability,
  type SellableProduct,
} from "@/lib/manualOrder";

/**
 * An order taken in person.
 *
 * Everything an online order does after payment, minus the payment: it records
 * the sale, decrements stock, issues an invoice in the same sequence, and
 * emails it if there is an address to send to. Downstream — orders, analytics,
 * the P&L, the exports — nothing knows or cares that it came from a stall.
 *
 * THE PRICE OVERRIDE IS A DELIBERATE EXCEPTION to the rule that runs the whole
 * checkout. Online, the browser's price is ignored and the database decides,
 * because the browser belongs to the customer. Here the operator IS the shop:
 * a discount agreed face to face is a real decision, and refusing to record it
 * would mean the books disagreed with the till. It is gated on is_admin() and
 * every order is audited.
 *
 * WHAT IS NOT OVERRIDABLE is cost. COGS is snapshotted from the catalogue, so
 * a generous discount shows up as thin margin in the P&L rather than quietly
 * rewriting what the piece cost to make.
 *
 * STOCK IS CHECKED BEFORE THE ORDER IS WRITTEN, and this is a change. It used
 * to record the sale, watch reserve_stock refuse it, flag the order and carry
 * on — which is right for an online payment, where the money has already left
 * the customer's account and refusing to record it would lose the order. In
 * person it is the wrong way round: the operator is holding the piece and can
 * look at the shelf, and the far more likely reading of "no stock" is a size
 * left unchosen or a count nobody has updated. So a shortage stops the sale and
 * says which line is short; recording it anyway is still available, but it is
 * now a decision someone made rather than a message they read afterwards.
 */
export const runtime = "nodejs";

interface ManualItem {
  productId: string;
  size: string;
  quantity: number;
  /** Unit price actually charged. May differ from the catalogue. */
  priceInr: number;
}

interface ManualOrderRequest {
  items: ManualItem[];
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  paymentMethod: PaymentMethod;
  note?: string;
  shippingCostInr?: number;
  /**
   * "The shelf and the count disagree, and the shelf is right." Set only by an
   * operator who has been shown exactly what is short and has said to record it
   * regardless. Never a default, and never inferred.
   */
  allowShort?: boolean;
}

export async function POST(request: NextRequest) {
  const session = createRSCClient();
  const { data: isAdmin } = await session.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const body = (await request.json()) as ManualOrderRequest;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "Add at least one item." }, { status: 400 });
  }
  if (!OFFLINE_METHODS.some((m) => m.id === body.paymentMethod)) {
    return NextResponse.json({ error: "Choose how it was paid for." }, { status: 400 });
  }

  // Same rules the form applies, applied again here. The form's copy exists so
  // the operator is told while the customer is still standing there; this one is
  // what actually decides, because a form is not an authority on anything.
  const customerProblem = validateCustomer({
    name: body.customerName ?? "",
    email: body.customerEmail ?? "",
    phone: body.customerPhone ?? "",
  });
  if (customerProblem) {
    return NextResponse.json({ error: customerProblem }, { status: 400 });
  }

  // Service role from here: reserve_stock and assign_invoice_number are
  // service-role functions, exactly as the Razorpay route uses them. The
  // ADMIN CHECK ABOVE IS WHAT AUTHORISES THIS — never reached without it.
  const db = createServiceClient();

  // Names and costs come from the catalogue, never from the request. The
  // operator sets what was charged; they do not get to state what a piece is
  // called or what it cost us.
  const ids = [...new Set(body.items.map((i) => i.productId))];
  const { data: products, error: lookupError } = await db
    .from("products")
    .select("id, name, sku, cost_price_inr")
    .in("id", ids);
  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  const byId = new Map(
    ((products ?? []) as unknown as Record<string, unknown>[]).map((p) => [String(p.id), p])
  );
  if (byId.size !== ids.length) {
    return NextResponse.json({ error: "One of those products no longer exists." }, { status: 400 });
  }

  // What is on the shelf, read the same way reserve_stock reads it: per size
  // where a product has sizes, and from the PUBLISHED version's own count where
  // it has none. Reading products.stock_quantity instead would look right and
  // answer a different question — that column is not the one a sale decrements.
  const [{ data: sizeRows }, { data: versionRows }] = await Promise.all([
    db
      .from("product_sizes")
      .select("product_id, label, stock_quantity")
      .in("product_id", ids)
      .order("sort_order"),
    db
      .from("product_versions")
      .select("product_id, stock_quantity")
      .in("product_id", ids)
      .eq("state", "published"),
  ]);

  const sizes = ((sizeRows ?? []) as unknown as {
    product_id: string;
    label: string;
    stock_quantity: number | string;
  }[]);

  const sizesByProduct = new Map<string, string[]>();
  for (const row of sizes) {
    sizesByProduct.set(row.product_id, [
      ...(sizesByProduct.get(row.product_id) ?? []),
      row.label,
    ]);
  }

  const catalogue: SellableProduct[] = ids.map((id) => ({
    id,
    name: String(byId.get(id)!.name),
    sizes: sizesByProduct.get(id) ?? [],
  }));

  const availability: Availability[] = [
    ...sizes.map((row) => ({
      productId: row.product_id,
      size: row.label,
      available: Number(row.stock_quantity ?? 0),
    })),
    // Only for products with no size rows — where a product has both, the size
    // rows are the truth and the version count is a leftover.
    ...((versionRows ?? []) as unknown as { product_id: string; stock_quantity: number | string }[])
      .filter((row) => !sizesByProduct.has(row.product_id))
      .map((row) => ({
        productId: row.product_id,
        size: "",
        available: Number(row.stock_quantity ?? 0),
      })),
  ];

  const lines = body.items.map((i) => ({
    productId: i.productId,
    size: i.size ?? "",
    quantity: i.quantity,
    priceInr: i.priceInr,
  }));

  const lineProblem = validateLines(lines, catalogue);
  if (lineProblem) {
    return NextResponse.json({ error: lineProblem }, { status: 400 });
  }

  const shortages = findShortages(lines, catalogue, availability);
  if (shortages.length > 0 && body.allowShort !== true) {
    // 409, not 400: nothing about the request is malformed. The shelf and the
    // count disagree, and which of them is right is not ours to decide from
    // here — so it goes back to the person who can see both.
    return NextResponse.json(
      {
        error: `Not enough stock — ${shortageMessage(shortages)}.`,
        shortages,
      },
      { status: 409 }
    );
  }

  const items = body.items.map((i) => {
    const p = byId.get(i.productId)!;
    const cost = p.cost_price_inr === null ? null : Number(p.cost_price_inr);
    return {
      id: i.productId,
      name: String(p.name),
      sku: (p.sku as string) ?? null,
      size: i.size || "One Size",
      quantity: i.quantity,
      price_inr: i.priceInr,
      cost_price_inr: cost,
    };
  });

  const goods = items.reduce((sum, i) => sum + i.price_inr * i.quantity, 0);
  const shipping = Number.isFinite(body.shippingCostInr) ? Number(body.shippingCostInr) : 0;
  const cogs = items.reduce((sum, i) => sum + (i.cost_price_inr ?? 0) * i.quantity, 0);

  const { data: created, error: insertError } = await db
    .from("orders")
    .insert({
      customer_email: body.customerEmail?.trim().toLowerCase() || null,
      customer_name: body.customerName?.trim() || null,
      customer_phone: body.customerPhone?.trim() || null,
      total_inr: goods + shipping,
      shipping_cost_inr: shipping,
      cogs_inr: cogs,
      items,
      payment_provider: "offline",
      payment_method: body.paymentMethod,
      // Paid by definition — the money arrived before the order was recorded.
      payment_status: "paid",
      // Confirmed, not "placed": someone has already handed it over or agreed
      // to. There is no window in which this order might not be going ahead.
      status: "confirmed",
      admin_note: body.note?.trim() || null,
      // Deliberately no gateway_fee_inr. Null here means "there was never a
      // fee", which 0044 teaches the P&L to read as fine rather than missing.
    })
    .select("id")
    .single();

  if (insertError || !created) {
    return NextResponse.json(
      { error: insertError?.message ?? "Could not record that order." },
      { status: 500 }
    );
  }
  const orderId = (created as { id: string }).id;

  // Stock comes out the same way a paid online order takes it, so the movement
  // log reads identically and a sale is a sale however it happened.
  const { error: stockError } = await db.rpc("reserve_stock", {
    p_items: items.map((i) => ({ id: i.id, size: i.size, quantity: i.quantity })),
    p_order_id: orderId,
  });
  if (stockError) {
    // Reaching here now means one of two things: the operator was shown the
    // shortage and chose to record the sale anyway, or the count moved between
    // the check above and this call. Either way the sale has happened, so it is
    // recorded and flagged rather than refused.
    //
    // NOTHING IS DECREMENTED, INCLUDING THE LINES THAT WERE IN STOCK.
    // reserve_stock is one call and one transaction, and per-line calls would
    // be worse than this: 0045 returns stock on cancellation only when a 'sale'
    // movement exists for the order, so an order that had reserved SOME of its
    // lines would be credited back in full and invent the difference. The
    // counts are corrected by hand instead, which 0039 logs.
    console.error(`Manual order ${orderId}: stock not reserved — ${stockError.message}`);
    await db.from("orders").update({ needs_review: true }).eq("id", orderId);
  }

  const { error: invoiceError } = await db.rpc("assign_invoice_number", {
    p_order_id: orderId,
  });
  if (invoiceError) {
    console.error(`Manual order ${orderId}: no invoice number — ${invoiceError.message}`);
  }

  // Emailed only if there is somewhere to send it. A market stall customer who
  // did not give an address still gets a recorded sale and an invoice on file.
  let emailed = false;
  if (body.customerEmail?.trim()) {
    try {
      const { data: row } = await db
        .from("orders")
        .select(INVOICE_SELECT)
        .eq("id", orderId)
        .maybeSingle();
      const invoice = row ? buildInvoice(row as unknown as Parameters<typeof buildInvoice>[0]) : null;
      if (invoice) {
        const pdf = await renderToBuffer(InvoiceDocument({ data: invoice }));
        const sent = await sendEmail({
          to: invoice.customer.email,
          subject: `Your invoice ${invoice.invoiceNumber} — THE WOVENNE`,
          html:
            `<p>Hello ${invoice.customer.name || "there"},</p>` +
            `<p>Thank you for your purchase. Your invoice <strong>${invoice.invoiceNumber}</strong> is attached.</p>` +
            `<p>THE WOVENNE</p>`,
          text: `Your invoice ${invoice.invoiceNumber} is attached.`,
          attachments: [
            { filename: `${invoice.invoiceNumber}.pdf`, content: Buffer.from(pdf).toString("base64") },
          ],
        });
        emailed = sent.ok;
      }
    } catch (e) {
      // Never fatal. The order exists and the invoice can be resent from the
      // invoice list; failing here would suggest the sale had not been recorded.
      console.error(`Manual order ${orderId}: invoice email failed`, e);
    }
  }

  const { data: finished } = await db
    .from("orders")
    .select("id, invoice_number, total_inr")
    .eq("id", orderId)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    orderId,
    invoiceNumber: (finished as { invoice_number?: string } | null)?.invoice_number ?? null,
    total: (finished as { total_inr?: number } | null)?.total_inr ?? goods + shipping,
    emailed,
    stockShort: Boolean(stockError),
  });
}

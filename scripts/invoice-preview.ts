/**
 * Render a sample invoice to a PDF, with no order and no database.
 *
 *   npx tsx scripts/invoice-preview.ts [outfile]
 *
 * Exists because the shop has no orders yet, so the design cannot otherwise be
 * looked at — and because a document that goes into a customer's records should
 * be reviewable without taking a payment to see it. The sample deliberately
 * carries both discount lines and a multi-line address, which is the busiest
 * the layout ever gets.
 */
import fs from "node:fs";
import { renderToBuffer } from "@react-pdf/renderer";
import InvoiceDocument from "../components/invoice/InvoiceDocument";
import { buildInvoice } from "../lib/invoice";

const order = {
  id: "11111111-2222-3333-4444-555555555555",
  invoice_number: "WOV-2026-0001",
  invoice_issued_at: "2026-08-07T10:12:00Z",
  created_at: "2026-08-07T09:58:00Z",
  customer_name: "Ananya Menon",
  customer_email: "ananya@example.com",
  customer_phone: "+91 98470 12345",
  shipping_address: {
    line1: "12 Beach Road",
    line2: "Near St Andrews",
    city: "Alappuzha",
    state: "Kerala",
    postal_code: "688001",
  },
  items: [
    { id: "p1", name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 4500 },
    { id: "p2", name: "Handwoven Linen Kurta", size: "M", quantity: 2, price_inr: 2200 },
  ],
  total_inr: 7810,
  shipping_cost_inr: 0,
  coupon_code: "LAUNCH10",
  coupon_discount_inr: 890,
  loyalty_discount_inr: 200,
  loyalty_points_spent: 200,
  payment_provider: "razorpay",
  payment_status: "paid",
  razorpay_order_id: "order_QxYz123ABC",
  tax: null,
};

async function main() {
  const data = buildInvoice(order as never);
  if (!data) {
    console.error("buildInvoice returned null — an invoice needs a number.");
    process.exit(1);
  }

  const derived = data.subtotal - data.couponDiscount - data.loyaltyDiscount + data.shipping;
  console.log(`subtotal from line items : ₹${data.subtotal}`);
  console.log(`less coupon              : −₹${data.couponDiscount} (${data.couponCode})`);
  console.log(`less loyalty             : −₹${data.loyaltyDiscount} (${data.loyaltyPoints} points)`);
  console.log(`plus delivery            : ₹${data.shipping}`);
  console.log(`derived                  : ₹${derived}`);
  console.log(`recorded total_inr       : ₹${data.total}`);
  console.log(`agree                    : ${derived === data.total ? "YES" : "NO — check the order row"}`);

  const buf = await renderToBuffer(InvoiceDocument({ data }) as never);
  const out = process.argv[2] ?? "invoice-preview.pdf";
  fs.writeFileSync(out, buf);
  console.log(`\nwrote ${out} — ${buf.length} bytes, header ${buf.subarray(0, 5).toString()}`);
}

void main();

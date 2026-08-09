/**
 * Render a sample credit note to a PDF, with no order and no database.
 *
 *   npx tsx scripts/credit-note-preview.ts [outfile]
 *
 * The companion to invoice-preview.ts, and here for the same reason plus one
 * more: the shop has no orders, so it has no cancellations either, and this is
 * the only way to look at the document before a real customer receives one.
 *
 * The lesson that made the invoice preview worth having applies twice over here
 * — the rupee sign has no glyph in PDF's built-in fonts and printed as a stray
 * mark, which was found by rendering the document and looking at it rather than
 * by reading the code.
 */
import fs from "node:fs";
import { renderToBuffer } from "@react-pdf/renderer";
import CreditNoteDocument from "../components/invoice/CreditNoteDocument";
import { buildCreditNote } from "../lib/creditNote";

const note = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  credit_note_number: "CN-2026-0001",
  order_id: "11111111-2222-3333-4444-555555555555",
  invoice_number: "WOV-2026-0001",
  kind: "cancellation",
  // A string, because PostgREST returns numerics as strings — the same trap the
  // Excel exports hit. If this were coerced anywhere but buildCreditNote, the
  // total would print as text.
  amount_inr: "7810.00",
  reason: "Customer changed their mind before dispatch",
  items: [
    { id: "p1", name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 4500 },
    { id: "p2", name: "Handwoven Linen Kurta", size: "M", quantity: 2, price_inr: 2200 },
  ],
  issued_at: "2026-08-09T11:30:00Z",
};

const order = {
  id: "11111111-2222-3333-4444-555555555555",
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
  payment_provider: "razorpay",
  payment_method: "razorpay",
  razorpay_order_id: "order_QxYz123ABC",
};

async function main() {
  const data = buildCreditNote(note, order);
  if (!data) {
    console.error("buildCreditNote returned null — a credit note needs a number.");
    process.exit(1);
  }

  console.log(`credit note        : ${data.creditNoteNumber}`);
  console.log(`credits invoice    : ${data.invoiceNumber}`);
  console.log(`amount             : ₹${data.amount} (${typeof data.amount})`);
  console.log(`lines credited     : ${data.lines.length}`);
  const linesTotal = data.lines.reduce((s, l) => s + l.price_inr * l.quantity, 0);
  console.log(`lines add up to    : ₹${linesTotal}`);
  console.log(
    `amount vs lines    : ${
      linesTotal === data.amount
        ? "equal"
        : `differ by ₹${linesTotal - data.amount} — expected when the order carried a discount or delivery`
    }`
  );

  const buf = await renderToBuffer(CreditNoteDocument({ data }) as never);
  const out = process.argv[2] ?? "credit-note-preview.pdf";
  fs.writeFileSync(out, buf);
  console.log(`\nwrote ${out} — ${buf.length} bytes, header ${buf.subarray(0, 5).toString()}`);
}

void main();

/**
 * Render the Invoice V2 layout for review, with no order and no database.
 *
 *   npx tsx scripts/invoice-v2-preview.ts <outdir outside the repo> [--v1]
 *
 * Writes one PDF per case. --v1 renders the same cases in the V1 layout for
 * side-by-side comparison. Sample data only: every name, number and address is
 * fictional, and the invoice numbers use a PREVIEW- prefix so a preview can
 * never be mistaken for, or collide with, a WOV- invoice.
 */
import fs from "node:fs";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import InvoiceDocumentV1 from "../components/invoice/InvoiceDocumentV1";
import InvoiceDocumentV2 from "../components/invoice/InvoiceDocumentV2";
import { buildInvoice } from "../lib/invoice";

const out = process.argv[2];
const v1 = process.argv.includes("--v1");
const repo = path.resolve(__dirname, "..");
if (!out || out.startsWith("--")) {
  console.error("usage: npx tsx scripts/invoice-v2-preview.ts <outdir outside the repo> [--v1]");
  process.exit(2);
}
const dir = path.resolve(out);
if (dir === repo || dir.startsWith(repo + path.sep)) {
  console.error(`Refusing to write previews inside the repository: ${dir}`);
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const address = {
  line1: "12 Beach Road",
  line2: "Near St Andrew's Church",
  city: "Alappuzha",
  state: "Kerala",
  postal_code: "688001",
  country: "India",
};

const base = {
  id: "a53c16f7-b5d3-48e5-b825-ed84aa335d59",
  invoice_number: "PREVIEW-0001",
  invoice_issued_at: "2026-11-02T06:30:00Z",
  created_at: "2026-11-02T06:28:00Z",
  customer_name: "Ananya Menon",
  customer_email: "ananya@example.com",
  customer_phone: "+91 98470 12345",
  shipping_address: address,
  items: [{ name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 8900 }],
  total_inr: 8900,
  shipping_cost_inr: 0,
  coupon_code: null,
  coupon_discount_inr: 0,
  loyalty_discount_inr: 0,
  loyalty_points_spent: 0,
  payment_provider: "razorpay",
  payment_method: "razorpay",
  payment_status: "paid",
  razorpay_order_id: "order_PxY12abCDef345",
  tax: null,
};

const many = Array.from({ length: 34 }, (_, i) => ({
  name: `Handloom cotton piece ${i + 1}${i % 5 === 0 ? " — natural dye, hand-finished selvedge, Chendamangalam weavers' cooperative" : ""}`,
  size: ["S", "M", "L", "Free", ""][i % 5],
  quantity: (i % 3) + 1,
  price_inr: 450 + i * 35,
}));
const manyTotal = many.reduce((n, l) => n + l.price_inr * l.quantity, 0);

const cases: Record<string, Parameters<typeof buildInvoice>[0]> = {
  "1-online-paid": base,
  "2-manual-order": {
    ...base,
    invoice_number: "PREVIEW-0002",
    id: "7c1e0b2a-0000-4000-8000-000000000002",
    payment_provider: "offline",
    payment_method: "upi",
    razorpay_order_id: null,
    shipping_address: null, // sold in person
    customer_phone: null,
  },
  "3-multiple-items-discounts": {
    ...base,
    invoice_number: "PREVIEW-0003",
    items: [
      { name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 8900 },
      { name: "Linen Kurta — Indigo", size: "M", quantity: 2, price_inr: 2450 },
      { name: "Handwoven Stole", size: "", quantity: 1, price_inr: 1200 },
    ],
    coupon_code: "WELCOME10",
    coupon_discount_inr: 1500,
    loyalty_discount_inr: 200,
    loyalty_points_spent: 200,
    shipping_cost_inr: 99,
    total_inr: 8900 + 4900 + 1200 - 1500 - 200 + 99,
  },
  "4-no-billing-address": {
    // No billing address is ever stored; this is the case with the least
    // customer detail the data allows: name and email, nothing else.
    ...base,
    invoice_number: "PREVIEW-0004",
    customer_phone: null,
    shipping_address: null,
    payment_method: null, // a row from before migration 0044
  },
  "5-long-names-addresses": {
    ...base,
    invoice_number: "PREVIEW-0005",
    customer_name: "Parvathy Lakshmi Ramachandran Pillai Thekkedathu Veettil",
    customer_email: "parvathy.lakshmi.ramachandran.pillai@a-rather-long-domain-name.example.com",
    shipping_address: {
      line1: "Flat 14B, Sreekrishna Residency Apartments, Second Cross Road off Mullackal Junction",
      line2: "Opposite the Government Higher Secondary School for Girls, Near Kidangamparambu Temple",
      city: "Thiruvananthapuram",
      state: "Kerala",
      postal_code: "695001",
      country: "India",
    },
    items: [
      {
        name: "Kuthampully handloom silk-cotton saree with zari border and woven peacock pallu, natural undyed body, 6.3 m with blouse piece",
        size: "Free",
        quantity: 1,
        price_inr: 12850,
      },
    ],
    total_inr: 12850,
  },
  "6-multi-page": {
    ...base,
    invoice_number: "PREVIEW-0006",
    items: many,
    shipping_cost_inr: 150,
    total_inr: manyTotal + 150,
  },
};

(async () => {
  for (const [name, order] of Object.entries(cases)) {
    const inv = buildInvoice(order)!;
    const doc = v1 ? InvoiceDocumentV1({ data: inv }) : InvoiceDocumentV2({ data: inv });
    const buf = await renderToBuffer(doc);
    const file = path.join(dir, `${v1 ? "v1" : "v2"}-${name}.pdf`);
    fs.writeFileSync(file, buf);
    console.log(`${path.basename(file)}  ${buf.length} bytes`);
  }
})();

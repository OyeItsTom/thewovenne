/**
 * Write the invoice emails (WP-EMAIL-E4) to HTML and text files for review.
 *
 *   npx tsx scripts/invoice-email-preview.ts <outdir>
 *
 * The output directory is required and must not be inside the repository, so
 * a preview can never be committed by accident. Sample data only: no order,
 * no database, nothing sent.
 */
import fs from "node:fs";
import path from "node:path";
import { buildInvoice } from "../lib/invoice";
import { invoiceEmail, invoiceEmailData } from "../lib/emails/invoice";

const out = process.argv[2];
const repo = path.resolve(__dirname, "..");
if (!out) {
  console.error("usage: npx tsx scripts/invoice-email-preview.ts <outdir outside the repo>");
  process.exit(2);
}
const dir = path.resolve(out);
if (dir === repo || dir.startsWith(repo + path.sep)) {
  console.error(`Refusing to write previews inside the repository: ${dir}`);
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const base = {
  id: "a53c16f7-b5d3-48e5-b825-ed84aa335d59",
  invoice_number: "WOV-2026-0043",
  invoice_issued_at: "2026-11-01T06:30:00Z",
  created_at: "2026-11-01T06:29:00Z",
  customer_name: "Ananya Menon",
  customer_email: "ananya@example.com",
  customer_phone: null,
  shipping_address: null,
  items: [{ id: "p1", name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 8900 }],
  total_inr: 8900,
  shipping_cost_inr: 0,
  payment_provider: "offline",
  payment_status: "paid",
  razorpay_order_id: null,
};
const manual = buildInvoice(base)!;
const online = buildInvoice({
  ...base,
  id: "11111111-2222-3333-4444-555555555555",
  invoice_number: "WOV-2026-0042",
  payment_provider: "razorpay",
  razorpay_order_id: "order_PxY12abCDef",
  total_inr: 7810,
})!;

const samples = {
  "1-manual-issued": invoiceEmailData(manual, { kind: "issued" }),
  "2-resend-copy": invoiceEmailData(online, { kind: "copy" }),
  "3-resend-cancelled": invoiceEmailData(online, { kind: "copy", cancelled: true, creditNoteNumbers: ["CN-2026-0002"] }),
  "4-hostile-name": {
    ...invoiceEmailData(manual, { kind: "issued" }),
    customerName: `<a href="https://evil.example">Verify</a> <script>alert(1)</script>`,
  },
  "5-no-name": { ...invoiceEmailData(manual, { kind: "issued" }), customerName: null },
};

for (const [name, d] of Object.entries(samples)) {
  const e = invoiceEmail(d);
  fs.writeFileSync(path.join(dir, `${name}.html`), e.html);
  fs.writeFileSync(path.join(dir, `${name}.txt`), `Subject: ${e.subject}\n\n${e.text}\n`);
}
console.log(`Wrote ${Object.keys(samples).length} previews to ${dir}`);

/**
 * Write the E5 emails (cancellation, style-photo rejection) to HTML and text
 * files for review.
 *
 *   npx tsx scripts/email-e5-preview.ts <outdir outside the repo>
 *
 * Sample data only: no order, no database, nothing sent. Refuses to write
 * inside the repository, so a preview can never be committed by accident.
 */
import fs from "node:fs";
import path from "node:path";
import { orderCancelledHtml, orderCancelledSubject, orderCancelledText, type CancelledEmailData } from "../lib/emails/orderCancelled";
import { styleRejectedHtml, styleRejectedSubject, styleRejectedText, type StyleRejectedData } from "../lib/emails/styleRejected";

const out = process.argv[2];
const repo = path.resolve(__dirname, "..");
if (!out) {
  console.error("usage: npx tsx scripts/email-e5-preview.ts <outdir outside the repo>");
  process.exit(2);
}
const dir = path.resolve(out);
if (dir === repo || dir.startsWith(repo + path.sep)) {
  console.error(`Refusing to write previews inside the repository: ${dir}`);
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const cancel: CancelledEmailData = {
  orderRef: "A53C16F7",
  customerName: "Ananya Menon",
  items: [
    { name: "Kerala Kasavu Saree", size: "Free", quantity: 1 },
    { name: "Handwoven Linen Kurta", size: "M", quantity: 2 },
  ],
  amount: 8900,
  creditNoteNumber: "CN-2026-0002",
  invoiceNumber: "WOV-2026-0043",
  reason: "The weaver could not finish the piece in time.",
  creditNoteAttached: true,
};
const style: StyleRejectedData = {
  customerName: "Ananya Menon",
  productName: "Mul Cotton Saree",
  reason: "The photograph is a little blurry — a sharper one would show the weave better.",
};

const cancels: Record<string, CancelledEmailData> = {
  "c1-cancelled-attached": cancel,
  "c2-cancelled-no-pdf-no-reason": { ...cancel, creditNoteAttached: false, reason: null, invoiceNumber: null, customerName: null },
  "c3-cancelled-long-hostile": {
    ...cancel,
    customerName: `<a href="https://evil.example">Verify</a>`,
    reason: `<script>alert(1)</script> ${"The piece was damaged in the dye bath and cannot be replaced. ".repeat(12)}`,
  },
};
const styles: Record<string, StyleRejectedData> = {
  "s1-style-rejected": style,
  "s2-style-no-product-hostile": { customerName: "<b>x</b>", productName: null, reason: `<img src=x onerror=alert(1)> Please send one without other people in it.` },
};

for (const [name, d] of Object.entries(cancels)) {
  fs.writeFileSync(path.join(dir, `${name}.html`), orderCancelledHtml(d));
  fs.writeFileSync(path.join(dir, `${name}.txt`), `Subject: ${orderCancelledSubject(d.orderRef)}\n\n${orderCancelledText(d)}\n`);
}
for (const [name, d] of Object.entries(styles)) {
  fs.writeFileSync(path.join(dir, `${name}.html`), styleRejectedHtml(d));
  fs.writeFileSync(path.join(dir, `${name}.txt`), `Subject: ${styleRejectedSubject(d.productName)}\n\n${styleRejectedText(d)}\n`);
}
console.log(`Wrote ${Object.keys(cancels).length + Object.keys(styles).length} previews to ${dir}`);

/**
 * Invoice V2: a monochrome invoice layout, chosen by issue date so issued
 * invoices keep the layout they were issued in.
 *
 *   npx tsx scripts/invoice-v2.test.ts
 *
 * No database and no network. PDFs are rendered in memory and their text is
 * read back out of the content streams, so these checks are on the document a
 * customer receives, not on the source that produces it.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { renderToBuffer } from "@react-pdf/renderer";
import InvoiceDocument from "../components/invoice/InvoiceDocument";
import InvoiceDocumentV1 from "../components/invoice/InvoiceDocumentV1";
import InvoiceDocumentV2 from "../components/invoice/InvoiceDocumentV2";
import { BUSINESS, buildInvoice, INVOICE_SELECT } from "../lib/invoice";
import { INVOICE_V2_FROM, invoiceLayoutFor, zonedInstant } from "../lib/invoiceLayout";

let passed = 0;
let failed = 0;
function t(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
}
const root = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

// ── PDF text, read back out ────────────────────────────────────────────────
// @react-pdf writes the standard fonts' text as hex strings inside TJ arrays.
function pdfPages(buf: Buffer): string[] {
  const src = buf.toString("latin1");
  const pages: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    if (!/\bBT\b/.test(content)) continue;
    const runs: string[] = [];
    for (const tj of content.matchAll(/\[(.*?)\]\s*TJ/g)) {
      runs.push(
        [...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join("")
      );
    }
    // A line is drawn as several runs (it breaks at spaces and numbers), so runs
    // are joined with nothing between them. Checks below are substring checks.
    pages.push(runs.join(""));
  }
  return pages;
}
const pageCount = (buf: Buffer) => (buf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;

// ── Fixtures (fictional) ───────────────────────────────────────────────────
const address = { line1: "12 Beach Road", line2: "", city: "Alappuzha", state: "Kerala", postal_code: "688001", country: "India" };
const base = {
  id: "a53c16f7-b5d3-48e5-b825-ed84aa335d59",
  invoice_number: "PREVIEW-0001",
  invoice_issued_at: "2026-11-02T06:30:00Z" as string | null,
  created_at: "2026-11-02T06:28:00Z",
  customer_name: "Ananya Menon",
  customer_email: "ananya@example.com",
  customer_phone: "+91 98470 12345",
  shipping_address: address as Record<string, string> | null,
  items: [{ name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 8900 }] as unknown,
  total_inr: 8900,
  shipping_cost_inr: 0,
  coupon_code: null as string | null,
  coupon_discount_inr: 0,
  loyalty_discount_inr: 0,
  loyalty_points_spent: 0,
  payment_provider: "razorpay",
  payment_method: "razorpay" as string | null,
  payment_status: "paid",
  razorpay_order_id: "order_PxY12abCDef345" as string | null,
  tax: null,
};
const online = buildInvoice(base)!;
const manual = buildInvoice({
  ...base,
  invoice_number: "PREVIEW-0002",
  payment_provider: "offline",
  payment_method: "upi",
  razorpay_order_id: null,
  shipping_address: null,
  customer_phone: null,
})!;
const discounted = buildInvoice({
  ...base,
  invoice_number: "PREVIEW-0003",
  items: [
    { name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 8900 },
    { name: "Linen Kurta", size: "M", quantity: 2, price_inr: 2450 },
  ],
  coupon_code: "WELCOME10",
  coupon_discount_inr: 1500,
  loyalty_discount_inr: 200,
  loyalty_points_spent: 200,
  shipping_cost_inr: 99,
  total_inr: 8900 + 4900 - 1500 - 200 + 99,
})!;
const legacy = buildInvoice({ ...base, invoice_number: "PREVIEW-0004", payment_method: null })!;
const many = buildInvoice({
  ...base,
  invoice_number: "PREVIEW-0006",
  items: Array.from({ length: 40 }, (_, i) => ({ name: `Piece ${i + 1}`, size: "M", quantity: 1, price_inr: 100 })),
  total_inr: 4000,
})!;

(async () => {
  console.log("\n=== layout choice (lib/invoiceLayout) ===");
  t("cutoff unset: every invoice is V1", invoiceLayoutFor("2030-01-01T00:00:00Z", null) === "v1");
  t("issued before the cutoff: V1", invoiceLayoutFor("2026-11-01T23:59:59Z", "2026-11-02T00:00:00Z") === "v1");
  t("issued at the cutoff: V2", invoiceLayoutFor("2026-11-02T00:00:00Z", "2026-11-02T00:00:00Z") === "v2");
  t("issued after the cutoff: V2", invoiceLayoutFor("2026-12-01T00:00:00Z", "2026-11-02T00:00:00Z") === "v2");
  t("unreadable issue date: V1", invoiceLayoutFor("not a date", "2026-11-02T00:00:00Z") === "v1");
  t("unreadable cutoff: V1", invoiceLayoutFor("2026-12-01T00:00:00Z", "soon") === "v1");
  t(
    "INVOICE_V2_FROM is unset (a release decision) or a zoned timestamp",
    INVOICE_V2_FROM === null || zonedInstant(INVOICE_V2_FROM) !== null,
    String(INVOICE_V2_FROM)
  );

  console.log("\n=== cutover edge cases ===");
  const CUT = "2026-11-10T09:00:00Z";
  t("PostgREST microseconds, 1 ms before: V1", invoiceLayoutFor("2026-11-10T08:59:59.999000+00:00", CUT) === "v1");
  t("PostgREST microseconds, at the cutoff: V2", invoiceLayoutFor("2026-11-10T09:00:00.000123+00:00", CUT) === "v2");
  t("Postgres text form with short offset", invoiceLayoutFor("2026-11-10 09:00:01+00", CUT) === "v2");
  t("IST offset: 14:29:59+05:30 is before 09:00Z", invoiceLayoutFor("2026-11-10T14:29:59+05:30", CUT) === "v1");
  t("IST offset: 14:30:00+05:30 is the cutoff", invoiceLayoutFor("2026-11-10T14:30:00+05:30", CUT) === "v2");
  t("compact offset +0530", invoiceLayoutFor("2026-11-10T14:30:00+0530", CUT) === "v2");
  t("cutoff without a zone leaves V2 off", invoiceLayoutFor("2027-01-01T00:00:00Z", "2026-11-10T09:00:00") === "v1");
  t("date-only cutoff leaves V2 off", invoiceLayoutFor("2027-01-01T00:00:00Z", "2026-11-10") === "v1");
  t("issue date without a zone stays V1", invoiceLayoutFor("2027-01-01T00:00:00", CUT) === "v1");
  t("empty issue date stays V1", invoiceLayoutFor("", CUT) === "v1");
  // Placed before the cutoff, paid and invoiced after it: decided by issue date.
  const lateInvoiced = buildInvoice({ ...base, created_at: "2026-11-09T10:00:00+00:00", invoice_issued_at: "2026-11-10T10:00:00+00:00" })!;
  t("ordered before, invoiced after: V2 (issue date decides)", invoiceLayoutFor(lateInvoiced.issuedAt, CUT) === "v2");
  const earlyInvoiced = buildInvoice({ ...base, created_at: "2026-11-09T10:00:00+00:00", invoice_issued_at: "2026-11-09T10:05:00+00:00" })!;
  t("historical re-download: an invoice issued before stays V1 forever", invoiceLayoutFor(earlyInvoiced.issuedAt, CUT) === "v1");
  const noIssued = buildInvoice({ ...base, created_at: "2026-11-09T10:00:00+00:00", invoice_issued_at: null })!;
  t("missing invoice_issued_at falls back to created_at (as V1 always has)", noIssued.issuedAt === "2026-11-09T10:00:00+00:00" && invoiceLayoutFor(noIssued.issuedAt, CUT) === "v1");

  console.log("\n=== the selector ===");
  const expectV1 = invoiceLayoutFor(online.issuedAt) === "v1";
  const chosen = InvoiceDocument({ data: online });
  const direct = expectV1 ? InvoiceDocumentV1({ data: online }) : InvoiceDocumentV2({ data: online });
  t("InvoiceDocument returns exactly the chosen layout's <Document>", isDeepStrictEqual(chosen, direct));
  const selSrc = read("components/invoice/InvoiceDocument.tsx");
  t("selector decides by data.issuedAt and nothing else", /invoiceLayoutFor\(data\.issuedAt\)/.test(selSrc));
  for (const f of ["app/api/invoice/[orderId]/route.ts", "app/api/admin/invoice/resend/route.ts", "app/api/admin/orders/manual/route.ts"]) {
    t(`${f} renders through the selector`, read(f).includes('from "@/components/invoice/InvoiceDocument"'));
  }

  console.log("\n=== figures unchanged (lib/invoice) ===");
  t("online: subtotal and total", online.subtotal === 8900 && online.total === 8900);
  t(
    "discounted: subtotal, coupon, loyalty, delivery, total",
    discounted.subtotal === 13800 &&
      discounted.couponDiscount === 1500 &&
      discounted.loyaltyDiscount === 200 &&
      discounted.shipping === 99 &&
      discounted.total === 12199
  );
  t("tax block stays null while unregistered", BUSINESS.gstin === null && discounted.tax === null);
  t("payment.method carried through", online.payment.method === "razorpay" && manual.payment.method === "upi");
  t("payment.method null on rows before 0044", legacy.payment.method === null);
  t("INVOICE_SELECT reads payment_method", /\bpayment_method\b/.test(INVOICE_SELECT));
  const posture = JSON.parse(read("supabase/security-posture.json"));
  const orders = posture.tables.orders;
  t(
    "customers can read payment_method (orders SELECT is table-wide, no column list)",
    orders.privileges.authenticated.includes("SELECT") && Object.keys(orders.columns ?? {}).length === 0
  );

  console.log("\n=== V2 source: monochrome, no invented content ===");
  const v2 = read("components/invoice/InvoiceDocumentV2.tsx");
  const colours = [...v2.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => m[1].toLowerCase());
  t(
    "every colour is a neutral grey, black or white",
    colours.length > 0 && colours.every((c) => c.slice(0, 2) === c.slice(2, 4) && c.slice(2, 4) === c.slice(4, 6)),
    colours.join(",")
  );
  t("exactly one image: the emblem", (v2.match(/<Image\b/g) ?? []).length === 1 && /<Image src=\{EMBLEM_PNG\}/.test(v2));
  t("emblem keeps the artwork's ratio", /height: \(40 \* EMBLEM_HEIGHT\) \/ EMBLEM_WIDTH/.test(v2));
  t("no tagline", !/Woven in India|Worn for life/i.test(v2));
  t("website link is https and the site's own", /const SITE_URL = "https:\/\/www\.thewovenne\.com";/.test(v2) && /<Link src=\{SITE_URL\}/.test(v2));
  t("brand set as \"thewovenne\"", /const WORDMARK = "thewovenne";/.test(v2));
  const brandAt = v2.indexOf("<View style={s.brand}>");
  t(
    "emblem, name and website form one block, in that order, before INVOICE",
    brandAt > 0 &&
      brandAt < v2.indexOf("<Image src={EMBLEM_PNG}") &&
      v2.indexOf("<Image src={EMBLEM_PNG}") < v2.indexOf("{WORDMARK}") &&
      v2.indexOf("{WORDMARK}") < v2.indexOf("<Link src={SITE_URL}") &&
      v2.indexOf("<Link src={SITE_URL}") < v2.indexOf(">INVOICE<")
  );
  t("no estimated, due or payable dates", !/due date|payable by|estimated/i.test(v2));

  console.log("\n=== V2 rendered: online paid ===");
  const onlineBuf = Buffer.from(await renderToBuffer(InvoiceDocumentV2({ data: online })));
  const onlineText = pdfPages(onlineBuf).join("\n");
  t("renders a PDF", onlineBuf.subarray(0, 5).toString() === "%PDF-");
  t("one page", pageCount(onlineBuf) === 1, String(pageCount(onlineBuf)));
  for (const s of ["INVOICE", "PREVIEW-0001", "2 November 2026", "BILLED TO", "DELIVERY ADDRESS", "12 Beach Road", "688001",
    "Razorpay (online)", "Kerala Kasavu Saree", "INR 8,900", "Total paid", "Delivery", "INR 0"]) {
    t(`prints "${s}"`, onlineText.includes(s));
  }
  t("Razorpay order id printed once (not repeated as payment reference)", onlineText.split("order_PxY12abCDef345").length - 1 === 1);
  t("no billing address heading (none is collected)", !/BILLING ADDRESS/i.test(onlineText));
  t("no GSTIN while unregistered", !onlineText.includes("GSTIN"));
  t("says it is not registered for GST", onlineText.includes("Not registered for GST. This invoice does not carry a tax component."));
  t("no tax line", !/\b(CGST|SGST|IGST)\b/.test(onlineText));
  const addressLine = `Thank you for choosing us. The Wovenne · ${BUSINESS.lines.join(", ")}`;
  t("seller address printed once, in the footer only", onlineText.split(BUSINESS.lines.join(", ")).length - 1 === 1 && onlineText.indexOf(addressLine) > onlineText.indexOf("Total paid"));
  t("header shows thewovenne and the website before INVOICE", onlineText.indexOf("thewovenne") >= 0 && onlineText.indexOf("thewovenne") < onlineText.indexOf("INVOICE") && onlineText.indexOf("www.thewovenne.com") < onlineText.indexOf("INVOICE"));
  t("website appears once (header only)", onlineText.split("www.thewovenne.com").length - 1 === 1);
  const raw = onlineBuf.toString("latin1");
  t("website is a clickable link annotation to https://www.thewovenne.com", /\/Subtype \/Link/.test(raw) && raw.includes("/URI (https://www.thewovenne.com)"));
  t("one image (+ its transparency mask): the emblem", (raw.match(/\/Subtype \/Image/g) ?? []).length === 2);

  console.log("\n=== V2 rendered: manual order, no address ===");
  const manualText = pdfPages(Buffer.from(await renderToBuffer(InvoiceDocumentV2({ data: manual })))).join("\n");
  t("payment method from payment_method", manualText.includes("UPI"));
  t("no address: says so rather than leaving a gap", manualText.includes("No delivery address recorded for this order."));
  t("order reference is the short ref", manualText.includes("A53C16F7"));
  t("no Razorpay wording", !/razorpay/i.test(manualText));

  console.log("\n=== V2 rendered: discounts ===");
  const discText = pdfPages(Buffer.from(await renderToBuffer(InvoiceDocumentV2({ data: discounted })))).join("\n");
  for (const s of ["Discount (WELCOME10)", "- INR 1,500", "Loyalty points (200)", "- INR 200", "INR 99", "INR 13,800", "INR 12,199", "INR 4,900"]) {
    t(`prints "${s}"`, discText.includes(s));
  }

  console.log("\n=== V2 rendered: pre-0044 row ===");
  const legacyText = pdfPages(Buffer.from(await renderToBuffer(InvoiceDocumentV2({ data: legacy })))).join("\n");
  t("falls back to the provider", legacyText.includes("Razorpay (online)"));

  console.log("\n=== V2 rendered: many items ===");
  const manyBuf = Buffer.from(await renderToBuffer(InvoiceDocumentV2({ data: many })));
  const manyPages = pdfPages(manyBuf);
  t("runs onto a second page", pageCount(manyBuf) >= 2, String(pageCount(manyBuf)));
  t("every item printed", Array.from({ length: 40 }, (_, i) => `Piece ${i + 1}`).every((n) => manyPages.join("\n").includes(n)));
  t("runs to more than one page", manyPages.length >= 2);
  t("column headings repeated on every page", manyPages.every((p) => p.includes("DESCRIPTION") && p.includes("AMOUNT")));
  t("GST statement on every page", manyPages.every((p) => p.includes("Not registered for GST")));
  t("seller address on every page", manyPages.every((p) => p.includes(`The Wovenne · ${BUSINESS.lines.join(", ")}`)));
  t("website link once, in the page-1 header", (manyBuf.toString("latin1").match(/\/URI \(https:\/\/www\.thewovenne\.com\)/g) ?? []).length === 1);
  t("total printed once", manyPages.join("\n").split("Total paid").length - 1 === 1);

  console.log(`\ninvoice-v2: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

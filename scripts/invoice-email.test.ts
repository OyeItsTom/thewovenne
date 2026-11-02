/**
 * WP-EMAIL-E4: branded invoice emails (lib/emails/invoice.ts, lib/invoiceEmail.ts).
 *
 * Proves:
 *   1. escaping: customer names, references and numbers can never become markup;
 *   2. the facts match the PDF: invoice number, date, order reference, total;
 *   3. wording: issued vs copy, cancelled + credit notes, never "you asked",
 *      never a cancelled invoice that reads as a live sale;
 *   4. HTML and text carry the same facts and sentences;
 *   5. no personal data beyond a first name, no links off the shop;
 *   6. delivery outcomes: no address / no invoice / not prepared / refused /
 *      unknown (timeout, 5xx, network) / accepted, and accepted is never called
 *      delivered;
 *   7. resend eligibility: paid, address, credit notes, cancelled-without-note;
 *   8. the routes: admin gate first, session client for resends, no writes to
 *      invoices or credit notes, old raw-HTML emails gone;
 *   9. PDF regression: the PDF still renders, and its source files are
 *      unchanged from main.
 *
 *   npx tsx scripts/invoice-email.test.ts
 *
 * Sends nothing and touches no database. Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextRequest } from "next/server";
import { isSameOrigin } from "../lib/sameOrigin";
import InvoiceDocument from "../components/invoice/InvoiceDocument";
import { buildInvoice, inr, type InvoiceData } from "../lib/invoice";
import { EMAIL_ORIGIN, EMBLEM_URL, escapeHtml, footerText } from "../lib/emails/layout";
import {
  greetingName,
  invoiceDate,
  invoiceEmail,
  invoiceEmailData,
  invoiceEmailHtml,
  invoiceEmailSubject,
  invoiceEmailText,
  type InvoiceEmailData,
} from "../lib/emails/invoice";
import {
  deliverInvoiceEmail,
  providerErrorIsDefinite,
  resendDecision,
  resendHttpStatus,
  type SendFn,
} from "../lib/invoiceEmail";

let passed = 0;
let failed = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const root = path.join(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
/** Strip comments so source checks look at code, not prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** HTML to visible text, roughly: tags out, entities decoded. */
const visible = (h: string) =>
  h
    .replace(/<div style="display:none[\s\S]*?<\/div>/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<br>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

// ── Fixtures ────────────────────────────────────────────────────────────────

const onlineOrder = {
  id: "11111111-2222-3333-4444-555555555555",
  invoice_number: "WOV-2026-0042",
  invoice_issued_at: "2026-08-07T10:12:00Z",
  created_at: "2026-08-07T09:58:00Z",
  customer_name: "Ananya Menon",
  customer_email: "ananya@example.com",
  customer_phone: "+91 98470 12345",
  shipping_address: { line1: "12 Beach Road", line2: "Near St Andrews", city: "Alappuzha", state: "Kerala", postal_code: "688001" },
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
  razorpay_order_id: "order_PxY12abCDef",
  tax: null,
};
const manualOrder = {
  ...onlineOrder,
  id: "a53c16f7-b5d3-48e5-b825-ed84aa335d59",
  invoice_number: "WOV-2026-0043",
  payment_provider: "offline",
  razorpay_order_id: null,
  shipping_address: null,
  coupon_code: null,
  coupon_discount_inr: 0,
  loyalty_discount_inr: 0,
  loyalty_points_spent: 0,
  total_inr: 8900.4,
};
const online = buildInvoice(onlineOrder)!;
const manual = buildInvoice(manualOrder)!;

const issued = (inv: InvoiceData = manual) => invoiceEmailData(inv, { kind: "issued" });
const copyOf = (inv: InvoiceData = online, extra: Partial<InvoiceEmailData> = {}) => ({
  ...invoiceEmailData(inv, { kind: "copy" }),
  ...extra,
});
const cancelledCopy = (notes: string[] = ["CN-2026-0002"]) =>
  invoiceEmailData(online, { kind: "copy", cancelled: true, creditNoteNumbers: notes });

// ── 1. Escaping ─────────────────────────────────────────────────────────────

const ATTACKS = [
  `<a href="https://evil.example/login">Verify your account</a>`,
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `"><svg/onload=alert(1)>`,
  `Ananya<b>bold</b>`,
  `&lt;b&gt;already-escaped`,
  `javascript:alert(1)`,
];
for (const name of ATTACKS) {
  for (const d of [{ ...issued(), customerName: name }, { ...copyOf(), customerName: name }]) {
    const h = invoiceEmailHtml(d);
    const x = invoiceEmailText(d);
    const first = greetingName(name);
    t(`greeting safe (${d.kind}): ${name}`, first === null ? h.includes(">Hello,<") && x.includes("\nHello,\n") : h.includes(`Hello ${escapeHtml(first)},`));
    t(`no markup characters greeted (${d.kind}): ${name}`, first === null || !/[<>]/.test(first));
    t(`no injected tags (${d.kind}): ${name}`, !/<script|<img src=x|<svg|<b>|evil\.example/i.test(h));
  }
}
{
  const h = invoiceEmailHtml({ ...issued(), customerName: `<a href="https://evil.example">x</a>` });
  t("hostile name: no href to another host", !/href="(?!https:\/\/www\.thewovenne\.com)/.test(h));
  t("hostile name: falls back to Hello,", h.includes(">Hello,<"));
  t("hostile name: script never raw", !invoiceEmailHtml({ ...issued(), customerName: "<script>x</script>" }).includes("<script"));
}
{
  // Dynamic values other than the name are escaped too, even though today
  // they come from the database.
  const h = invoiceEmailHtml({ ...copyOf(), invoiceNumber: `WOV<i>1`, orderReference: `ref"><b>x`, creditNoteNumbers: ["CN<u>1"] });
  t("invoice number escaped", h.includes("WOV&lt;i&gt;1") && !h.includes("<i>"));
  t("order reference escaped", h.includes("ref&quot;&gt;&lt;b&gt;x") && !h.includes("<b>x"));
  t("credit note number escaped", h.includes("CN&lt;u&gt;1") && !h.includes("<u>"));
  t("title escaped", /<title>Your invoice WOV&lt;i&gt;1 — THE WOVENNE<\/title>/.test(h));
}
t("subject strips newlines", !/[\r\n]/.test(invoiceEmailSubject("WOV-2026-0001\r\nBcc: x@y")));

// ── 2. Names ────────────────────────────────────────────────────────────────

const greet = (name: string | null) => {
  const d = { ...issued(), customerName: name };
  return { h: invoiceEmailHtml(d), x: invoiceEmailText(d) };
};
for (const empty of [null, "", "   ", "​​", "‮", "\t\n"]) {
  const { h, x } = greet(empty);
  t(`empty name ${JSON.stringify(empty)} → "Hello,"`, x.includes("\nHello,\n") && h.includes(">Hello,<"));
}
for (const { h, x } of [greet(null), greet("Ananya")]) {
  t("never 'there'", !/\bthere\b/i.test(x) && !/\bthere\b/i.test(visible(h)));
}
t("first name only", greet("Ananya Menon").x.includes("Hello Ananya,") && !greet("Ananya Menon").x.includes("Menon"));
t("Malayalam name kept", greet("അനന്യ മേനോൻ").x.includes("Hello അനന്യ,"));
t("Devanagari name kept", greet("अनन्या").x.includes("Hello अनन्या,"));
t("ampersand name escaped", greet("A&B").h.includes("Hello A&amp;B,"));
t("apostrophe name escaped in HTML", greet("O'Brien").h.includes("Hello O&#39;Brien,") && greet("O'Brien").x.includes("Hello O'Brien,"));
t("bidi override removed", !greet("‮Ananya").x.includes("‮") && greet("‮Ananya").x.includes("Hello Ananya,"));
t("zero-width removed", greet("An\u200banya").x.includes("Hello Ananya,"));
t("very long name capped", greetingName("A".repeat(5000))!.length === 40);
t("leading spaces and newlines", greet("\n  Ravi\nKumar").x.includes("Hello Ravi,"));

// ── 3. Facts match the PDF ──────────────────────────────────────────────────

// Both invoice layouts (Invoice V2 keeps V1 for invoices issued before it), so
// whichever one an invoice is drawn in, the email quotes the same facts.
for (const layout of ["InvoiceDocumentV1", "InvoiceDocumentV2"]) {
  const pdfSource = read(`components/invoice/${layout}.tsx`);
  t(
    `${layout}: date format is the one the email copies`,
    pdfSource.includes(`new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })`)
  );
  t(`${layout}: prints issuedAt with dateOf`, pdfSource.includes("{dateOf(data.issuedAt)}"));
  t(`${layout}: prints data.orderReference`, pdfSource.includes("{data.orderReference}"));
  t(`${layout}: prints the total with inr()`, /inr\(data\.total\)/.test(pdfSource));
}

for (const [label, inv, d] of [
  ["manual issued", manual, issued(manual)],
  ["online copy", online, copyOf(online)],
  ["online cancelled", online, cancelledCopy()],
] as const) {
  const e = invoiceEmail(d);
  const date = new Date(inv.issuedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  for (const [fact, value] of [
    ["invoice number", inv.invoiceNumber],
    ["date", date],
    ["order reference", inv.orderReference],
    ["total", inr(inv.total)],
  ]) {
    t(`${label}: ${fact} in HTML`, e.html.includes(value), value);
    t(`${label}: ${fact} in text`, e.text.includes(value), value);
  }
  t(`${label}: says the PDF is attached (HTML)`, /attached to this email as a PDF/.test(e.html));
  t(`${label}: says the PDF is attached (text)`, /attached to this email as a PDF/.test(e.text));
}
t("invoiceDate matches PDF format", invoiceDate("2026-08-07T10:12:00Z") === new Date("2026-08-07T10:12:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }));
t("online reference is the Razorpay id (as the PDF)", issued(online).orderReference === "order_PxY12abCDef");
t("manual reference is the short ref (as the PDF)", issued(manual).orderReference === manual.orderReference && !manual.orderReference.includes("-b5d3-"));
t("paise total rounds as the PDF does", invoiceEmailText(issued(manual)).includes("Invoice total: INR 8,900"));
t("subject unchanged from before E4", invoiceEmailSubject("WOV-2026-0043") === "Your invoice WOV-2026-0043 — THE WOVENNE");
t("invoiceEmail().subject is the subject", invoiceEmail(issued()).subject === "Your invoice WOV-2026-0043 — THE WOVENNE");

// ── 4. Wording ──────────────────────────────────────────────────────────────

{
  const e = invoiceEmail(issued());
  t("issued: heading", e.html.includes(">Your invoice</h1>"));
  t("issued: thanks", e.text.includes("Thank you for your purchase."));
  t("issued: records line", e.text.includes("Please keep it for your records."));
  t("issued: no cancellation wording", !/cancel|credit note/i.test(e.text));
}
{
  const e = invoiceEmail(copyOf());
  t("copy: heading", e.html.includes(">A copy of your invoice</h1>") && e.text.startsWith("A copy of your invoice\n"));
  t("copy: no thanks-for-purchase", !e.text.includes("Thank you for your purchase"));
  t("copy: no cancellation wording", !/cancel|credit note/i.test(e.text));
}
for (const d of [copyOf(), cancelledCopy(), issued()]) {
  const all = invoiceEmailText(d) + visible(invoiceEmailHtml(d));
  t(`${d.kind}${d.cancelled ? " cancelled" : ""}: never says the customer asked`, !/as requested|you asked|your request|you requested/i.test(all));
  t(`${d.kind}${d.cancelled ? " cancelled" : ""}: no delivery claim`, !/delivered|in your inbox|received/i.test(all));
  t(`${d.kind}${d.cancelled ? " cancelled" : ""}: no payment request`, !/please pay|amount due|balance due|pay now|due date/i.test(all));
  t(`${d.kind}${d.cancelled ? " cancelled" : ""}: nothing promotional`, !/discount|offer|sale\b|new arrivals|shop now|collection/i.test(all));
}
{
  const e = invoiceEmail(cancelledCopy());
  t("cancelled: says cancelled", e.text.includes("This order was cancelled, and credit note CN-2026-0002 was issued against this invoice."));
  t("cancelled: same sentence in HTML", visible(e.html).includes("This order was cancelled, and credit note CN-2026-0002 was issued against this invoice."));
  t("cancelled: not a payment request", e.text.includes("It is not a request for payment.") && e.html.includes("It is not a request for payment."));
  t("cancelled: status fact", e.text.includes("Order status: Cancelled") && visible(e.html).includes("Order status: Cancelled"));
  t("cancelled: credit note fact", e.text.includes("Credit note: CN-2026-0002"));
  t("cancelled: no records-only 'keep' line duplicated", !e.text.includes("Please keep it for your records."));
  t("cancelled: preheader", e.html.includes("A copy of invoice WOV-2026-0042, for a cancelled order, is attached as a PDF."));
}
{
  const e = invoiceEmail(cancelledCopy(["CN-2026-0002", "CN-2026-0005", "CN-2026-0002"]));
  t("two credit notes: listed once each", e.text.includes("credit notes CN-2026-0002 and CN-2026-0005 were issued"));
  t("two credit notes: fact plural", e.text.includes("Credit notes: CN-2026-0002, CN-2026-0005"));
  const three = invoiceEmailText(cancelledCopy(["CN-1", "CN-2", "CN-3"]));
  t("three credit notes: Oxford-free list", three.includes("credit notes CN-1, CN-2 and CN-3 were issued"));
}
{
  // A return credit note on an order that is not cancelled is named too, so the
  // copy never reads as if nothing had been credited.
  const x = invoiceEmailText(copyOf(online, { creditNoteNumbers: ["CN-2026-0009"] }));
  t("return credit note named", x.includes("Credit note CN-2026-0009 was issued against this invoice.") && !/cancelled/i.test(x));
  t("return credit note: not a payment request", x.includes("It is not a request for payment.") && !x.includes("Please keep it for your records."));
  t("no credit notes: no payment-request disclaimer needed", !invoiceEmailText(copyOf()).includes("request for payment"));
}
t("cancelled without credit notes refused by template", throws(() => invoiceEmailHtml(cancelledCopy([]))));
t("cancelled with blank credit notes still refused by resendDecision", !resendDecision({ invoice_number: "W", payment_status: "paid", status: "cancelled", customer_email: "a@b.co" }, [" ", ""]).ok);
t("issued with credit notes refused", throws(() => invoiceEmailHtml({ ...issued(), creditNoteNumbers: ["CN-1"] })));
t("issued cancelled refused", throws(() => invoiceEmailHtml({ ...issued(), cancelled: true, creditNoteNumbers: ["CN-1"] })));
t("empty invoice number refused", throws(() => invoiceEmailHtml({ ...issued(), invoiceNumber: " " })));
t("empty order reference refused", throws(() => invoiceEmailHtml({ ...issued(), orderReference: "" })));
t("NaN total refused", throws(() => invoiceEmailHtml({ ...issued(), total: Number.NaN })));
t("bad date refused", throws(() => invoiceEmailHtml({ ...issued(), issuedAt: "not a date" })));
t("unknown kind refused", throws(() => invoiceEmailHtml({ ...issued(), kind: "reminder" as never })));

// ── 5. Structure, links, personal data ─────────────────────────────────────

for (const d of [issued(manual), issued(online), copyOf(), cancelledCopy()]) {
  const label = `${d.kind}${d.cancelled ? " cancelled" : ""}`;
  const h = invoiceEmailHtml(d);
  const x = invoiceEmailText(d);
  t(`${label}: doctype + lang`, h.startsWith("<!doctype html>") && h.includes('<html lang="en">'));
  t(`${label}: emblem header`, h.includes(`src="${EMBLEM_URL}"`) && h.includes('alt="THE WOVENNE emblem"'));
  t(`${label}: wordmark text (images-blocked fallback)`, h.includes(">THE WOVENNE</div>"));
  t(`${label}: one image`, (h.match(/<img /g) ?? []).length === 1);
  t(`${label}: preheader present`, /<div style="display:none[^>]*>[^<]+<\/div>/.test(h));
  t(`${label}: no scripts or forms`, !/<script|<form|<iframe|<style/i.test(h));
  const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  t(`${label}: links only to the shop`, hrefs.length > 0 && hrefs.every((u) => u.startsWith(`${EMAIL_ORIGIN}/`)), hrefs.join(" "));
  t(`${label}: no buttons`, !h.includes("border-radius:999px"));
  t(`${label}: transactional footer (HTML)`, h.includes("Need help? Our contact details are on our website."));
  t(`${label}: transactional footer (text)`, x.endsWith(footerText({ kind: "transactional" })));
  t(`${label}: no marketing footer`, !/unsubscribe|marketing preferences|your preferences/i.test(h + x));
  t(`${label}: sign-off`, x.includes("Kind regards,\nThe Wovenne Team") && h.includes("Kind regards,<br>The Wovenne Team"));
  for (const pii of ["ananya@example.com", "98470", "Beach Road", "688001", "Kasavu", "Linen Kurta", "Menon", "LAUNCH10"]) {
    t(`${label}: no ${pii}`, !h.includes(pii) && !x.includes(pii));
  }
  t(`${label}: text has no markup`, !/<[a-z/!]/i.test(x));
  // Parity: every line of the text body (above the footer) is in the HTML.
  const bodyLines = x.split("\n--\n")[0].split("\n").map((l) => l.trim()).filter(Boolean);
  const vis = visible(h);
  const missing = bodyLines.filter((l) => !vis.includes(l.replace(/\s+/g, " ")));
  t(`${label}: text/HTML parity`, missing.length === 0, missing.join(" | "));
}

// ── 6. Delivery outcomes ───────────────────────────────────────────────────

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
function fakeSend(answer: (() => Promise<{ ok: boolean; error: string | null }>) | { ok: boolean; error: string | null }) {
  const calls: Parameters<SendFn>[0][] = [];
  const send: SendFn = async (m) => {
    calls.push(m);
    return typeof answer === "function" ? answer() : answer;
  };
  return { send, calls };
}
const renderPdf = async () => PDF;

async function deliveryTests() {
  {
    const f = fakeSend({ ok: true, error: null });
    const o = await deliverInvoiceEmail({ invoice: manual, kind: "issued" }, { send: f.send, renderPdf });
    t("accepted: status", o.status === "accepted");
    t("accepted: message is not a delivery claim", /accepted by the email provider/.test(o.message) && /does not confirm it reached their inbox/.test(o.message));
    t("accepted: sent once", f.calls.length === 1);
    const m = f.calls[0];
    t("accepted: to the order's address", m.to === "ananya@example.com");
    t("accepted: subject", m.subject === "Your invoice WOV-2026-0043 — THE WOVENNE");
    t("accepted: branded html", m.html.includes(EMBLEM_URL) && m.html.includes(">Your invoice</h1>"));
    t("accepted: text part", m.text.includes("Thank you for your purchase."));
    t("accepted: one attachment, same filename", m.attachments.length === 1 && m.attachments[0].filename === "WOV-2026-0043.pdf");
    t("accepted: attachment is the rendered PDF", m.attachments[0].content === Buffer.from(PDF).toString("base64"));
  }
  {
    const f = fakeSend({ ok: true, error: null });
    await deliverInvoiceEmail({ invoice: online, kind: "copy", cancelled: true, creditNoteNumbers: ["CN-2026-0002"] }, { send: f.send, renderPdf });
    t("resend cancelled: copy heading + credit note", f.calls[0].html.includes("A copy of your invoice") && f.calls[0].text.includes("CN-2026-0002"));
    t("resend cancelled: still exactly one attachment (no credit-note PDF)", f.calls[0].attachments.length === 1 && f.calls[0].attachments[0].filename === "WOV-2026-0042.pdf");
  }
  {
    const f = fakeSend({ ok: true, error: null });
    const o = await deliverInvoiceEmail({ invoice: null, kind: "issued" }, { send: f.send, renderPdf });
    t("no invoice: status", o.status === "no_invoice" && f.calls.length === 0);
    t("no invoice: says nothing was sent", /No invoice email was sent/.test(o.message));
  }
  for (const email of ["", "   "]) {
    const f = fakeSend({ ok: true, error: null });
    const o = await deliverInvoiceEmail({ invoice: { ...manual, customer: { ...manual.customer, email } }, kind: "issued" }, { send: f.send, renderPdf });
    t(`no address ${JSON.stringify(email)}: status`, o.status === "no_address" && f.calls.length === 0);
  }
  {
    const f = fakeSend({ ok: true, error: null });
    const o = await deliverInvoiceEmail({ invoice: manual, kind: "issued" }, { send: f.send, renderPdf: async () => { throw new Error("font missing"); } });
    t("PDF failure: not prepared, nothing sent", o.status === "not_prepared" && f.calls.length === 0 && /No invoice email was sent/.test(o.message));
  }
  {
    const f = fakeSend({ ok: true, error: null });
    const o = await deliverInvoiceEmail({ invoice: online, kind: "copy", cancelled: true, creditNoteNumbers: [] }, { send: f.send, renderPdf });
    t("template refusal: not prepared, nothing sent", o.status === "not_prepared" && f.calls.length === 0);
  }
  for (const [error, status] of [
    ["Resend 422", "rejected"],
    ["Resend 403", "rejected"],
    ["Resend 429", "rejected"],
    ["Email is not configured.", "rejected"],
    ["Resend 500", "unknown"],
    ["Resend 503", "unknown"],
    ["Send failed.", "unknown"],
    [null, "unknown"],
  ] as const) {
    const f = fakeSend({ ok: false, error });
    const o = await deliverInvoiceEmail({ invoice: manual, kind: "issued" }, { send: f.send, renderPdf });
    t(`provider ${error}: ${status}`, o.status === status, o.status);
    if (status === "rejected") t(`provider ${error}: says not sent`, /was not sent/.test(o.message) && /send it again from Invoices/.test(o.message));
    if (error === "Email is not configured.") t("not configured: not blamed on the provider", /not configured on this server/.test(o.message) && !/provider refused/.test(o.message));
    if (status === "unknown") t(`provider ${error}: says not known, check first`, /not known whether/.test(o.message) && /Check with the customer before sending it again/.test(o.message));
  }
  {
    const f = fakeSend(() => Promise.reject(new Error("socket hang up")));
    const o = await deliverInvoiceEmail({ invoice: manual, kind: "issued" }, { send: f.send, renderPdf });
    t("send throws: unknown, never thrown", o.status === "unknown");
  }
  {
    const f = fakeSend(() => new Promise(() => {}));
    const started = Date.now();
    const o = await deliverInvoiceEmail({ invoice: manual, kind: "issued" }, { send: f.send, renderPdf, timeoutMs: 30 });
    t("timeout: unknown", o.status === "unknown" && o.detail === "timeout");
    t("timeout: message", /did not answer within/.test(o.message) && /not known whether/.test(o.message));
    t("timeout: returned promptly", Date.now() - started < 2000);
  }
  t("429 is definite (not accepted)", providerErrorIsDefinite("Resend 429"));
  t("odd strings are not definite", !providerErrorIsDefinite("Resend 4220") && !providerErrorIsDefinite("resend 422"));
  for (const s of ["accepted", "no_address", "no_invoice", "not_prepared", "rejected", "unknown"] as const) {
    t(`http status for ${s}`, Number.isInteger(resendHttpStatus(s)));
  }
  t("only accepted is 200", resendHttpStatus("accepted") === 200 && resendHttpStatus("unknown") === 504 && resendHttpStatus("rejected") === 502);
}

// ── 7. Resend eligibility ──────────────────────────────────────────────────

const row = (o: Partial<Parameters<typeof resendDecision>[0]> = {}) => ({
  invoice_number: "WOV-2026-0042",
  payment_status: "paid",
  status: "confirmed",
  customer_email: "ananya@example.com",
  ...o,
});
{
  const d = resendDecision(row(), []);
  t("paid, live: allowed, not cancelled", d.ok && !d.cancelled && d.creditNoteNumbers.length === 0);
  const r = resendDecision(row({ invoice_number: null }), []);
  t("no invoice number: 409", !r.ok && r.httpStatus === 409);
  for (const ps of ["pending", "failed", "refunded", null]) {
    const u = resendDecision(row({ payment_status: ps }), []);
    t(`unpaid (${ps}): refused 409`, !u.ok && u.httpStatus === 409 && /not marked paid/.test(u.error));
  }
  const ne = resendDecision(row({ customer_email: null }), []);
  t("no email: 400", !ne.ok && ne.httpStatus === 400);
  const ws = resendDecision(row({ customer_email: "  " }), []);
  t("blank email: 400", !ws.ok && ws.httpStatus === 400);
  const unread = resendDecision(row({ status: "cancelled" }), null);
  t("credit notes unreadable: refused, not guessed", !unread.ok && unread.httpStatus === 503);
  const unreadLive = resendDecision(row(), null);
  t("credit notes unreadable on a live order: refused too", !unreadLive.ok);
  const none = resendDecision(row({ status: "cancelled" }), []);
  t("cancelled, no credit note: refused 409", !none.ok && none.httpStatus === 409);
  t("cancelled, no credit note: clear explanation", !none.ok && /cancelled but has no credit note/.test(none.error) && /no records were changed/.test(none.error));
  const some = resendDecision(row({ status: "cancelled" }), ["CN-2026-0002", "CN-2026-0002", "CN-2026-0003"]);
  t("cancelled with credit notes: allowed, deduped", some.ok && some.cancelled && some.creditNoteNumbers.join() === "CN-2026-0002,CN-2026-0003");
  const ret = resendDecision(row({ status: "delivered" }), ["CN-2026-0009"]);
  t("return credit note on live order: allowed, named, not cancelled", ret.ok && !ret.cancelled && ret.creditNoteNumbers[0] === "CN-2026-0009");
  // Order of checks: an unpaid cancelled order is refused as unpaid.
  const uc = resendDecision(row({ status: "cancelled", payment_status: "pending" }), []);
  t("unpaid + cancelled: refused as unpaid", !uc.ok && /not marked paid/.test(uc.error));
}

// ── 8. Routes and admin screens ────────────────────────────────────────────

{
  const resend = code(read("app/api/admin/invoice/resend/route.ts"));
  const gate = resend.indexOf("adminApiGate(request)");
  const admin = resend.indexOf('rpc("is_admin")');
  const firstRead = resend.indexOf('.from("orders")');
  t("resend: gate, then is_admin, then reads", gate > 0 && admin > gate && firstRead > admin);
  t("resend: not-admin is 404", /isAdmin !== true\) return new NextResponse\("Not found", \{ status: 404 \}\)/.test(resend));
  t("resend: admin session, not the service role", resend.includes("createRSCClient()") && !resend.includes("createServiceClient"));
  t("resend: reads credit notes by order", resend.includes('.from("credit_notes")') && resend.includes('.eq("order_id", orderId)'));
  t("resend: decides with resendDecision before sending", resend.indexOf("resendDecision(") > 0 && resend.indexOf("resendDecision(") < resend.indexOf("deliverInvoiceEmail("));
  t("resend: kind copy", /kind: "copy"/.test(resend));
  t("resend: no writes", !/\.(insert|update|upsert|delete)\(/.test(resend));
  t("resend: no numbering or credit-note RPCs", !/assign_invoice_number|issue_credit_note|cancel_order/.test(resend));
  t("resend: PDF input select unchanged", resend.includes("`${INVOICE_SELECT}, status`"));
  t("resend: old raw HTML gone", !resend.includes("<p>Hello") && !resend.includes("customer.name ||"));
  t("resend: uses sendEmail", resend.includes("send: sendEmail"));

  const manualRoute = code(read("app/api/admin/orders/manual/route.ts"));
  t("manual: gate, then is_admin, then body", manualRoute.indexOf("adminApiGate(request)") > 0 && manualRoute.indexOf('rpc("is_admin")') > manualRoute.indexOf("adminApiGate(request)") && manualRoute.indexOf("request.json()") > manualRoute.indexOf('rpc("is_admin")'));
  t("manual: kind issued via deliverInvoiceEmail", /deliverInvoiceEmail\(\s*\{ invoice, kind: "issued" \}/.test(manualRoute));
  t("manual: old raw HTML gone", !manualRoute.includes("<p>Hello") && !manualRoute.includes("customer.name ||"));
  t("manual: invoice number still assigned once", (manualRoute.match(/rpc\("assign_invoice_number"/g) ?? []).length === 1);
  t("manual: reports status and message", manualRoute.includes("invoiceEmailStatus: invoiceEmail.status") && manualRoute.includes("invoiceEmailMessage: invoiceEmail.message"));
  t("manual: emailed only when accepted", manualRoute.includes('const emailed = invoiceEmail.status === "accepted"'));
  t("manual: no-address default", manualRoute.includes('status: "no_address"'));

  const form = read("components/admin/ManualOrderForm.tsx");
  t("form: no 'always sent' claim", !/always sent/i.test(form) && !/it is sent to this address/.test(form));
  t("form: no 'Invoice emailed to the customer'", !form.includes("Invoice emailed to the customer"));
  t("form: shows the route's message", form.includes("done.invoiceEmailMessage"));
  const list = read("components/admin/InvoiceManager.tsx");
  t("invoices: success label is not 'Sent'", !list.includes('"Sent"') && list.includes('"Accepted"'));
  t("invoices: confirm mentions cancellation", list.includes("The order is cancelled: the email will say so"));
}

// ── 8b. Same-origin (PR #222 security correction) ──────────────────────────

{
  const req = (url: string, origin?: string | null) =>
    new NextRequest(url, { method: "POST", headers: origin === undefined || origin === null ? {} : { origin } });
  const RESEND = "https://www.thewovenne.com/api/admin/invoice/resend";
  const MANUAL = "https://www.thewovenne.com/api/admin/orders/manual";
  for (const url of [RESEND, MANUAL]) {
    const name = url.endsWith("resend") ? "resend" : "manual";
    t(`${name}: same-origin admin page permitted`, isSameOrigin(req(url, "https://www.thewovenne.com")));
    t(`${name}: cross-origin refused`, !isSameOrigin(req(url, "https://evil.example")));
    t(`${name}: look-alike host refused`, !isSameOrigin(req(url, "https://www.thewovenne.com.evil.example")));
    t(`${name}: apex vs www refused`, !isSameOrigin(req(url, "https://thewovenne.com")));
    t(`${name}: absent Origin refused`, !isSameOrigin(req(url)));
    t(`${name}: "null" Origin refused`, !isSameOrigin(req(url, "null")));
    t(`${name}: malformed Origin refused`, !isSameOrigin(req(url, "not a url")));
    t(`${name}: empty Origin refused`, !isSameOrigin(req(url, "")));
  }
  t("local dev same port permitted", isSameOrigin(req("http://localhost:3000/api/admin/invoice/resend", "http://localhost:3000")));
  t("local dev other port refused", !isSameOrigin(req("http://localhost:3000/api/admin/invoice/resend", "http://localhost:3001")));
  t("Vercel preview host permitted on its own host", isSameOrigin(req("https://thewovenne-git-x.vercel.app/api/admin/orders/manual", "https://thewovenne-git-x.vercel.app")));

  // Order in both routes: gate → same-origin → is_admin → anything else.
  for (const [name, file, firsts] of [
    ["resend", "app/api/admin/invoice/resend/route.ts", ["request.json()", '.from("orders")', '.from("credit_notes")', "deliverInvoiceEmail("]],
    ["manual", "app/api/admin/orders/manual/route.ts", ["request.json()", "createServiceClient()", '.insert(', 'rpc("reserve_stock"', 'rpc("assign_invoice_number"', "deliverInvoiceEmail("]],
  ] as const) {
    const src = code(read(file));
    const gate = src.indexOf("await adminApiGate(request)");
    const origin = src.indexOf("if (!isSameOrigin(request)) return NextResponse.json({ ok: false, error: \"Not allowed.\" }, { status: 403 })");
    const admin = src.indexOf('rpc("is_admin")');
    t(`${name}: imports the shared helper`, src.includes('import { isSameOrigin } from "@/lib/sameOrigin"'));
    t(`${name}: same-origin check present, 403`, origin > 0, String(origin));
    t(`${name}: adminApiGate before same-origin`, gate > 0 && gate < origin);
    t(`${name}: same-origin before is_admin`, origin < admin);
    t(`${name}: exactly one same-origin check`, (src.match(/isSameOrigin\(request\)/g) ?? []).length === 1);
    for (const f of firsts) {
      const at = src.indexOf(f);
      t(`${name}: ${f} only after same-origin and is_admin`, at > admin && at > origin, String(at));
    }
  }
}

// ── 9. PDF regression ──────────────────────────────────────────────────────

async function pdfTests() {
  for (const [label, inv] of [["online", online], ["manual", manual]] as const) {
    const buf = Buffer.from(await renderToBuffer(InvoiceDocument({ data: inv })));
    t(`${label} PDF renders`, buf.subarray(0, 5).toString() === "%PDF-" && buf.length > 2000, String(buf.length));
  }
  // E4's own invariants, by file. Only files no other email PR owns: the
  // credit-note document and builder, the download routes, and the two
  // migrations that define invoice and credit-note numbering. lib/email.ts,
  // lib/emails/layout.ts and the migrations folder as a whole legitimately
  // change when #220/#221/#223 are combined, so they are checked below by the
  // contract E4 relies on instead of by "unchanged from main".
  //
  // The invoice document and lib/invoice.ts are no longer on this list: Invoice
  // V2 adds a second layout and one printed field (payment_method). Their
  // invariants are checked instead, by scripts/invoice-v2.test.ts (figures
  // unchanged) and just below (the V1 layout byte-identical to the one E4 shipped).
  try {
    execFileSync(
      "git",
      ["diff", "--quiet", "main", "--", "components/invoice/CreditNoteDocument.tsx", "lib/creditNote.ts", "app/api/invoice", "app/api/credit-note",
        "supabase/migrations/0037_coupons_and_invoices.sql", "supabase/migrations/0043_credit_notes.sql"],
      { cwd: root }
    );
    t("credit-note PDF and builder, download routes and numbering migrations unchanged from main", true);
  } catch {
    t("credit-note PDF and builder, download routes and numbering migrations unchanged from main", false, "git diff main shows changes");
  }
  // 76aa2d8 is main before E4 and before Invoice V2: the layout every invoice
  // issued so far was drawn in.
  try {
    const shipped = execFileSync("git", ["show", "76aa2d8:components/invoice/InvoiceDocument.tsx"], { cwd: root, encoding: "utf8" });
    const v1 = fs.existsSync(path.join(root, "components/invoice/InvoiceDocumentV1.tsx"))
      ? read("components/invoice/InvoiceDocumentV1.tsx")
      : read("components/invoice/InvoiceDocument.tsx");
    t("V1 invoice layout byte-identical to the one already issued (76aa2d8)", v1 === shipped);
  } catch (e) {
    t("V1 invoice layout byte-identical to the one already issued (76aa2d8)", false, String(e));
  }

  // Numbering: defined once, never redefined by a later migration (any PR).
  const migDir = path.join(root, "supabase", "migrations");
  const migs = fs.readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f));
  const definers = (re: RegExp) => migs.filter((f) => re.test(code(fs.readFileSync(path.join(migDir, f), "utf8")).replace(/^\s*--.*$/gm, "")));
  for (const [what, re, only] of [
    ["assign_invoice_number()", /create\s+(or\s+replace\s+)?function\s+public\.assign_invoice_number\b/i, "0037_coupons_and_invoices.sql"],
    ["invoice_number_seq", /create\s+sequence\s+(if\s+not\s+exists\s+)?invoice_number_seq\b/i, "0037_coupons_and_invoices.sql"],
    ["issue_credit_note()", /create\s+(or\s+replace\s+)?function\s+public\.issue_credit_note\b/i, "0043_credit_notes.sql"],
    ["credit_note_number_seq", /create\s+sequence\s+(if\s+not\s+exists\s+)?credit_note_number_seq\b/i, "0043_credit_notes.sql"],
  ] as const) {
    const found = definers(re);
    t(`numbering: ${what} defined only in ${only}`, found.length === 1 && found[0] === only, found.join(", "));
  }
  t("numbering: no migration alters or resets the invoice / credit-note sequences",
    definers(/(alter|drop)\s+sequence\s+[^;]*\b(invoice_number_seq|credit_note_number_seq)\b|setval\s*\(\s*'(invoice_number_seq|credit_note_number_seq)'/i).length === 0);

  // The email contract E4 uses (true on main and after R1 adds fields).
  const emailSrc = code(read("lib/email.ts"));
  t("email contract: sendEmail is exported", /export async function sendEmail\s*\(/.test(emailSrc));
  for (const field of ["to: string;", "subject: string;", "html: string;", "text: string;", "attachments?: { filename: string; content: string }[];"]) {
    t(`email contract: sendEmail accepts ${field}`, emailSrc.includes(field));
  }
  t("email contract: result carries ok and error", /ok: boolean;/.test(emailSrc) && /error: string \| null;/.test(emailSrc));
  t("email contract: attachments still reach Resend", /attachments: opts\.attachments\?\.length \? opts\.attachments : undefined/.test(emailSrc));
  const layoutSrc = read("lib/emails/layout.ts");
  for (const helper of ["renderEmail", "heading", "greeting", "greetingText", "paragraph", "strong", "infoBox", "closing", "footerText", "html"]) {
    t(`layout contract: ${helper} still exported`, new RegExp(`export (function|const) ${helper}\\b`).test(layoutSrc));
  }
}

(async () => {
  await deliveryTests();
  await pdfTests();
  console.log(`\ninvoice-email: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

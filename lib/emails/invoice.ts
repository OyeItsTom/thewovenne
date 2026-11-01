/**
 * The invoice email (WP-EMAIL-E4): sent with a manual (in-person) order's
 * invoice, and again whenever an admin resends one.
 *
 * Built only from the E1 layout helpers, so every value from the order is
 * escaped by construction. The old emails put the customer's name into the
 * HTML raw; for an online order that name is typed by the customer.
 *
 * WHAT IT CARRIES, AND WHY ONLY THAT. The PDF is the document. The email
 * says what is attached and repeats the facts a customer searches for later:
 * the invoice number, its date, the order reference and the total. Each is
 * shown exactly as the PDF prints it. Same `inr()`, same date format, same
 * order reference, so the two can never disagree. No address, phone or line
 * items (they are in the PDF and need not travel in the body), no buttons, no
 * links beyond the footer's own, nothing promotional.
 *
 * A RESEND IS A COPY, NOT A NEW REQUEST. Its wording never says the customer
 * asked for it (an admin may have sent it unprompted). If credit notes exist
 * it names them. If the order was cancelled it says so, and that the copy is
 * not a request for payment.
 */
import {
  CLOSING_TEXT,
  closing,
  footer,
  footerText,
  greeting,
  greetingText,
  heading,
  html,
  infoBox,
  paragraph,
  renderEmail,
  strong,
  type EmailFooter,
  type SafeHtml,
} from "./layout";
import { inr, type InvoiceData } from "../invoice";

export type InvoiceEmailKind = "issued" | "copy";

export interface InvoiceEmailData {
  /** "issued": sent with a new manual-order invoice. "copy": an admin resend. */
  kind: InvoiceEmailKind;
  customerName: string | null;
  invoiceNumber: string;
  /** ISO timestamp; printed as the PDF prints it. */
  issuedAt: string;
  /** The reference the PDF prints (Razorpay id online, short ref in person). */
  orderReference: string;
  /** What was charged, as on the PDF. */
  total: number;
  /** The order has been cancelled. Only meaningful with credit notes. */
  cancelled: boolean;
  /** Credit notes issued against this invoice, oldest first. */
  creditNoteNumbers: readonly string[];
}

export interface InvoiceEmail {
  subject: string;
  html: string;
  text: string;
}

const FOOTER: EmailFooter = { kind: "transactional" };

/** Unchanged from the emails E4 replaces, so inbox searches still find them. */
export function invoiceEmailSubject(invoiceNumber: string): string {
  return `Your invoice ${oneLine(invoiceNumber)} — THE WOVENNE`;
}

/**
 * The date as the PDF prints it (InvoiceDocument's dateOf: en-IN, numeric day,
 * long month, numeric year, in the process's time zone, the same process
 * that renders the PDF attached to this email).
 */
export function invoiceDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

/** Shape the email from the same InvoiceData the PDF is rendered from. */
export function invoiceEmailData(
  invoice: InvoiceData,
  opts: { kind: InvoiceEmailKind; cancelled?: boolean; creditNoteNumbers?: readonly string[] }
): InvoiceEmailData {
  return {
    kind: opts.kind,
    customerName: invoice.customer.name,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    orderReference: invoice.orderReference,
    total: invoice.total,
    cancelled: opts.cancelled === true,
    creditNoteNumbers: opts.creditNoteNumbers ?? [],
  };
}

/**
 * A name fit for a greeting: control, format (bidi, zero-width) and other
 * invisible characters removed, then capped. Escaping is the layout's job.
 * This only stops a name from rearranging or flooding the line it sits in.
 */
export function greetingName(name: string | null | undefined): string | null {
  const cleaned = String(name ?? "")
    .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .trim();
  // Markup characters never appear in a real name. A name carrying them is
  // escaped anyway, but "Hello <a," helps nobody, so it is left out.
  if (!cleaned || /[<>]/.test(cleaned)) return null;
  const first = cleaned.split(/\s+/)[0];
  return Array.from(first).slice(0, 40).join("");
}

function oneLine(s: string): string {
  return String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function check(d: InvoiceEmailData): void {
  if (!oneLine(d.invoiceNumber)) throw new TypeError("Invoice email needs an invoice number.");
  if (!oneLine(d.orderReference)) throw new TypeError("Invoice email needs an order reference.");
  if (!Number.isFinite(d.total)) throw new TypeError("Invoice email needs a finite total.");
  if (Number.isNaN(new Date(d.issuedAt).getTime())) throw new TypeError("Invoice email needs a valid issue date.");
  if (d.kind !== "issued" && d.kind !== "copy") throw new TypeError(`Unknown invoice email kind: ${String(d.kind)}`);
  if (d.kind === "issued" && (d.cancelled || d.creditNoteNumbers.length > 0)) {
    // A new invoice cannot already be credited. Refused rather than rendered
    // with an impossible sentence.
    throw new TypeError("A newly issued invoice cannot carry credit notes.");
  }
  if (d.cancelled && d.creditNoteNumbers.length === 0) {
    // The resend route refuses this case; the template refuses it too, so a
    // cancelled invoice can never go out looking like a live sale.
    throw new TypeError("A cancelled order's invoice needs its credit notes.");
  }
}

function creditNotes(d: InvoiceEmailData): string[] {
  return [...new Set(d.creditNoteNumbers.map(oneLine).filter(Boolean))];
}

/** "CN-2026-0001", "CN-2026-0001 and CN-2026-0002", "A, B and C". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The facts, as label/value pairs, shared by both parts so they cannot drift. */
function facts(d: InvoiceEmailData): [string, string][] {
  const notes = creditNotes(d);
  return [
    ["Invoice", oneLine(d.invoiceNumber)],
    ["Invoice date", invoiceDate(d.issuedAt)],
    ["Order", oneLine(d.orderReference)],
    ["Invoice total", inr(d.total)],
    ...(d.cancelled ? ([["Order status", "Cancelled"]] as [string, string][]) : []),
    ...(notes.length ? ([[notes.length === 1 ? "Credit note" : "Credit notes", notes.join(", ")]] as [string, string][]) : []),
  ];
}

/** The sentences, in order, shared by both parts. */
function copy(d: InvoiceEmailData): { title: string; preheader: string; lead: string; credit: string | null; after: string } {
  const n = oneLine(d.invoiceNumber);
  const notes = creditNotes(d);
  const noteWord = notes.length === 1 ? "credit note" : "credit notes";
  const wasWere = notes.length === 1 ? "was" : "were";

  if (d.kind === "issued") {
    return {
      title: "Your invoice",
      preheader: `Your invoice ${n} is attached as a PDF.`,
      lead: "Thank you for your purchase. Your invoice is attached to this email as a PDF.",
      credit: null,
      after: "Please keep it for your records.",
    };
  }
  return {
    title: "A copy of your invoice",
    preheader: d.cancelled
      ? `A copy of invoice ${n}, for a cancelled order, is attached as a PDF.`
      : `A copy of invoice ${n} is attached as a PDF.`,
    lead: "Here is a copy of your invoice. It is attached to this email as a PDF.",
    credit: d.cancelled
      ? `This order was cancelled, and ${noteWord} ${listOf(notes)} ${wasWere} issued against this invoice.`
      : notes.length
        ? `${notes.length === 1 ? "Credit note" : "Credit notes"} ${listOf(notes)} ${wasWere} issued against this invoice.`
        : null,
    // Any credited invoice says outright that it asks for nothing, so the
    // total in the box is never read as an amount due.
    after: d.cancelled || notes.length
      ? "This copy is for your records only. It is not a request for payment."
      : "Please keep it for your records.",
  };
}

export function invoiceEmailHtml(d: InvoiceEmailData): string {
  check(d);
  const c = copy(d);
  const rows = facts(d).map(([label, value], i) => html`${i ? html`<br>` : ""}${label}: ${strong(value)}`);
  const body: SafeHtml[] = [
    heading(c.title),
    greeting(greetingName(d.customerName)),
    paragraph(c.lead, { spaceAfter: c.credit ? 16 : 24 }),
    ...(c.credit ? [paragraph(c.credit)] : []),
    infoBox(html`${rows}`),
    paragraph(c.after, { tone: "small" }),
    closing(),
  ];
  return renderEmail({ title: invoiceEmailSubject(d.invoiceNumber), preheader: c.preheader, body, footer: FOOTER });
}

export function invoiceEmailText(d: InvoiceEmailData): string {
  check(d);
  const c = copy(d);
  return [
    c.title,
    "",
    greetingText(greetingName(d.customerName)),
    "",
    c.lead,
    ...(c.credit ? ["", c.credit] : []),
    "",
    ...facts(d).map(([label, value]) => `${label}: ${value}`),
    "",
    c.after,
    "",
    CLOSING_TEXT,
    "",
    "--",
    footerText(FOOTER),
  ].join("\n");
}

export function invoiceEmail(d: InvoiceEmailData): InvoiceEmail {
  return { subject: invoiceEmailSubject(d.invoiceNumber), html: invoiceEmailHtml(d), text: invoiceEmailText(d) };
}

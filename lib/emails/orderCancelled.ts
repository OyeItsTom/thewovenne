/**
 * The email a customer gets when their order is cancelled (rebuilt on the E1
 * layout in WP-EMAIL-E5).
 *
 * WHAT IT RECORDS, AND WHAT IT DOES NOT CLAIM. Cancelling issues a credit
 * note: a document saying what is credited against the invoice. Nothing in the
 * application issues or records the refund itself, so this email never says a
 * refund was made, started, or will land anywhere by any date. It says what
 * the credit note is and that it is not itself a refund.
 *
 * IT DOES NOT SAY THE PARCEL WAS NEVER SENT. cancel_order() accepts orders
 * that are already shipped or delivered, and this email does not know which.
 *
 * THE ATTACHMENT IS MENTIONED ONLY WHEN IT IS ATTACHED. The caller says
 * whether the credit-note PDF was rendered and attached.
 *
 * THE REASON is whatever the admin typed, shown escaped and capped at 500
 * characters here. The credit note keeps the full text.
 *
 * Every value is escaped by the layout (lib/emails/layout.ts). No links beyond
 * the footer's own, no reply-to promise.
 */
import {
  CLOSING_TEXT,
  closing,
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
import { customerVisibleText, greetingName } from "./greetingName";
import { inr } from "../invoice";

/** One line of the cancelled order, as stored on it. */
export interface CancelledEmailItem {
  name: string;
  size?: string | null;
  quantity: number;
}

export interface CancelledEmailData {
  orderRef: string;
  customerName: string | null;
  items: readonly CancelledEmailItem[];
  /** The credit note's own amount (amount_inr), not the order total. */
  amount: number;
  creditNoteNumber: string;
  invoiceNumber: string | null;
  /** As typed by whoever cancelled it. Shown only when there is one. */
  reason: string | null;
  /** True only when the credit-note PDF is attached to this very email. */
  creditNoteAttached: boolean;
}

/** Characters of the reason shown to the customer. The record keeps it all. */
export const CANCELLATION_REASON_MAX = 500;

const FOOTER: EmailFooter = { kind: "transactional" };

export function orderCancelledSubject(orderRef: string): string {
  return `Your THE WOVENNE order ${oneLine(orderRef)} has been cancelled`;
}

function oneLine(s: string): string {
  return String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function check(d: CancelledEmailData): void {
  if (!oneLine(d.orderRef)) throw new TypeError("Cancellation email needs an order reference.");
  if (!oneLine(d.creditNoteNumber)) throw new TypeError("Cancellation email needs a credit note number.");
  if (!Number.isFinite(d.amount) || d.amount < 0) throw new TypeError("Cancellation email needs a valid credited amount.");
}

function itemLine(i: CancelledEmailItem): string {
  const size = i.size && i.size !== "One Size" ? ` · ${oneLine(i.size)}` : "";
  return `${oneLine(i.name) || "Item"}${size} × ${Number(i.quantity) || 0}`;
}

function cleanItems(items: readonly CancelledEmailItem[]): CancelledEmailItem[] {
  return (Array.isArray(items) ? items : []).filter((i) => i && (i.name || i.quantity));
}

/** Shared by HTML and text, in order, so the two cannot drift. */
function parts(d: CancelledEmailData) {
  const ref = oneLine(d.orderRef);
  const cn = oneLine(d.creditNoteNumber);
  const reason = customerVisibleText(d.reason, CANCELLATION_REASON_MAX);
  const facts: [string, string][] = [
    ["Order", ref],
    ...(d.invoiceNumber && oneLine(d.invoiceNumber) ? ([["Invoice", oneLine(d.invoiceNumber)]] as [string, string][]) : []),
    ["Credit note", cn],
    ["Amount credited", inr(d.amount)],
  ];
  return {
    preheader: d.creditNoteAttached
      ? `Order ${ref} has been cancelled. Credit note ${cn} is attached.`
      : `Order ${ref} has been cancelled. Credit note ${cn} has been issued.`,
    lead: `Your order ${ref} has been cancelled.`,
    reason: reason ? `Reason: ${reason}` : null,
    facts,
    creditNote: d.invoiceNumber && oneLine(d.invoiceNumber)
      ? `We have issued credit note ${cn} against invoice ${oneLine(d.invoiceNumber)}. It records the amount credited to you; it is not confirmation that a refund has been paid.`
      : `We have issued credit note ${cn}. It records the amount credited to you; it is not confirmation that a refund has been paid.`,
    attachment: d.creditNoteAttached ? "The credit note is attached to this email as a PDF." : null,
    itemsHeading: "What was cancelled:",
    items: cleanItems(d.items).map(itemLine),
  };
}

export function orderCancelledHtml(d: CancelledEmailData): string {
  check(d);
  const p = parts(d);
  const rows = p.facts.map(([label, value], i) => html`${i ? html`<br>` : ""}${label}: ${strong(value)}`);
  const body: SafeHtml[] = [
    heading("Your order has been cancelled"),
    greeting(greetingName(d.customerName)),
    paragraph(p.lead, { spaceAfter: p.reason ? 12 : 24 }),
    ...(p.reason ? [paragraph(p.reason)] : []),
    infoBox(html`${rows}`),
    paragraph(p.creditNote, { spaceAfter: p.attachment ? 12 : 24 }),
    ...(p.attachment ? [paragraph(p.attachment)] : []),
    ...(p.items.length
      ? [
          paragraph(p.itemsHeading, { tone: "small", spaceAfter: 6 }),
          paragraph(html`${p.items.map((l, i) => html`${i ? html`<br>` : ""}${l}`)}`, { tone: "small" }),
        ]
      : []),
    closing(),
  ];
  return renderEmail({ title: orderCancelledSubject(d.orderRef), preheader: p.preheader, body, footer: FOOTER });
}

export function orderCancelledText(d: CancelledEmailData): string {
  check(d);
  const p = parts(d);
  return [
    "Your order has been cancelled",
    "",
    greetingText(greetingName(d.customerName)),
    "",
    p.lead,
    ...(p.reason ? ["", p.reason] : []),
    "",
    ...p.facts.map(([label, value]) => `${label}: ${value}`),
    "",
    p.creditNote,
    ...(p.attachment ? ["", p.attachment] : []),
    ...(p.items.length ? ["", p.itemsHeading, ...p.items.map((l) => `- ${l}`)] : []),
    "",
    CLOSING_TEXT,
    "",
    "--",
    footerText(FOOTER),
  ].join("\n");
}

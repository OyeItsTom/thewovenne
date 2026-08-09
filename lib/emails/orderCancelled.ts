import { formatINR } from "../utils";
import type { OrderEmailItem } from "./orderConfirmation";

/**
 * The email a customer gets when their order is cancelled.
 *
 * IT DID NOT EXIST. Cancelling issued a credit note, put the stock back and
 * marked the order — and told the customer nothing at all. They had been sent a
 * confirmation and an invoice; the next thing they would have known about it is
 * a parcel that never came, or a refund appearing with no explanation.
 *
 * WHAT IT DOES NOT SAY IS THAT THE MONEY IS BACK. The credit note records what
 * is owed; the refund itself is made in Razorpay or in cash and nothing here can
 * see it land. So this says a refund is on its way and roughly when, which is
 * true, rather than "you have been refunded", which would not be.
 *
 * Same construction as the confirmation: table layout, inline styles, a text
 * part alongside.
 */

export interface CancelledEmailData {
  orderRef: string;
  customerName: string;
  items: OrderEmailItem[];
  /** What is being credited — the credit note's amount, not the order total. */
  amount: number;
  creditNoteNumber: string;
  invoiceNumber: string | null;
  /** As typed by whoever cancelled it. Shown only when there is one. */
  reason: string | null;
  /** True when the money arrived in person, so no gateway will send it back. */
  paidInPerson: boolean;
}

const INK = "#1C1F3B";
const TERRACOTTA = "#C2714F";
const MUTED = "#6b6b76";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * How the money comes back.
 *
 * An in-person sale has no gateway to reverse, so promising an automatic refund
 * to the original payment method would be a promise nobody can keep. It says the
 * shop will be in touch instead, which is what actually happens.
 */
function refundLine(d: CancelledEmailData): string {
  return d.paidInPerson
    ? "We'll be in touch to arrange your refund — this order was paid in person, so there's no card or UPI payment for us to reverse."
    : "Your refund goes back to the way you paid, and usually reaches you within 5 to 7 working days.";
}

export function orderCancelledSubject(orderRef: string): string {
  return `Your THE WOVENNE order ${orderRef} has been cancelled`;
}

export function orderCancelledText(d: CancelledEmailData): string {
  const lines = d.items.map(
    (i) =>
      `- ${i.name}${i.size && i.size !== "One Size" ? ` (${i.size})` : ""} x${i.quantity}`
  );
  return [
    `Hello ${d.customerName},`,
    "",
    `Your order ${d.orderRef} has been cancelled.`,
    ...(d.reason ? ["", `Reason: ${d.reason}`] : []),
    "",
    "What was cancelled:",
    ...lines,
    "",
    `Credited: ${formatINR(d.amount)}`,
    `Credit note: ${d.creditNoteNumber}${
      d.invoiceNumber ? ` (against invoice ${d.invoiceNumber})` : ""
    }`,
    "The credit note is attached.",
    "",
    refundLine(d),
    "",
    "If this is a surprise, reply to this email and we'll sort it out.",
    "",
    "THE WOVENNE",
  ].join("\n");
}

export function orderCancelledHtml(d: CancelledEmailData): string {
  const rows = d.items
    .map(
      (i) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #eee;color:${INK};">
            ${escapeHtml(i.name)}${
              i.size && i.size !== "One Size"
                ? `<span style="color:${MUTED};"> · ${escapeHtml(i.size)}</span>`
                : ""
            }
            <span style="color:${MUTED};"> × ${i.quantity}</span>
          </td>
        </tr>`
    )
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
            <tr>
              <td style="padding-bottom:28px;">
                <div style="font-size:22px;letter-spacing:2px;color:${INK};">THE WOVENNE</div>
                <div style="font-size:12px;color:${MUTED};margin-top:4px;">Woven in India. Worn for life.</div>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:8px;font-size:24px;color:${INK};">
                Your order has been cancelled.
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px;font-size:15px;line-height:1.6;color:${MUTED};">
                Hello ${escapeHtml(d.customerName)} — order
                <strong style="color:${INK};">${escapeHtml(d.orderRef)}</strong>
                has been cancelled${
                  d.reason ? `: ${escapeHtml(d.reason)}` : ""
                }. Nothing will be sent to you.
              </td>
            </tr>
            <tr>
              <td style="padding:14px 16px;background:#F0EAD6;border-radius:8px;font-size:13px;line-height:1.7;color:${INK};">
                Credited <strong>${formatINR(d.amount)}</strong><br>
                Credit note <strong>${escapeHtml(d.creditNoteNumber)}</strong>${
                  d.invoiceNumber
                    ? ` against invoice ${escapeHtml(d.invoiceNumber)}`
                    : ""
                }<br>
                <span style="color:${MUTED};">Attached to this email, for your records.</span>
              </td>
            </tr>
            <tr><td style="height:28px;"></td></tr>
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">
                  ${rows}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding-top:20px;font-size:14px;line-height:1.6;color:${MUTED};">
                ${escapeHtml(refundLine(d))}
              </td>
            </tr>
            <tr><td style="height:32px;"></td></tr>
            <tr>
              <td style="border-top:1px solid #eee;padding-top:20px;font-size:12px;line-height:1.6;color:${MUTED};">
                If this is a surprise, just reply to this email — it reaches us
                directly and we'll sort it out.
                <br><br>
                <span style="color:${TERRACOTTA};">THE WOVENNE</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

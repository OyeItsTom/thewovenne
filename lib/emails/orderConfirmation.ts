import { formatINR } from "../utils";
import type { ShippingAddress } from "../orderDetails";

/**
 * The email a customer gets after paying.
 *
 * Plain HTML with inline styles and a table layout, because that is what mail
 * clients render reliably — Outlook has no flexbox and Gmail strips <style>
 * blocks. A text part is always sent alongside: some people read mail as text,
 * and a message with no text part scores worse with spam filters.
 */

export interface OrderEmailItem {
  name: string;
  size: string;
  quantity: number;
  price_inr: number;
}

export interface OrderEmailData {
  orderRef: string;
  customerName: string;
  items: OrderEmailItem[];
  total: number;
  address: ShippingAddress;
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

function addressLines(a: ShippingAddress): string[] {
  return [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(
    (l) => !!l && l.trim().length > 0
  );
}

export function orderConfirmationSubject(orderRef: string): string {
  // The reference goes in the subject so a customer searching their inbox for
  // it finds the mail, which is what people actually do.
  return `Your THE WOVENNE order — ${orderRef}`;
}

export function orderConfirmationText(d: OrderEmailData): string {
  const lines = d.items.map(
    (i) =>
      `- ${i.name}${i.size && i.size !== "One Size" ? ` (${i.size})` : ""} x${i.quantity} — ${formatINR(
        i.price_inr * i.quantity
      )}`
  );
  return [
    `Thank you, ${d.customerName}.`,
    "",
    `We've received your order and we're preparing it now.`,
    "",
    `Order reference: ${d.orderRef}`,
    "",
    "What you ordered:",
    ...lines,
    "",
    `Total paid: ${formatINR(d.total)}`,
    "",
    "Delivering to:",
    ...addressLines(d.address),
    "",
    "We'll email you again as soon as it ships.",
    "",
    "Woven in India. Worn for life.",
    "THE WOVENNE",
  ].join("\n");
}

export function orderConfirmationHtml(d: OrderEmailData): string {
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
          <td align="right" style="padding:12px 0;border-bottom:1px solid #eee;color:${INK};white-space:nowrap;">
            ${formatINR(i.price_inr * i.quantity)}
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
                Thank you, ${escapeHtml(d.customerName)}.
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px;font-size:15px;line-height:1.6;color:${MUTED};">
                We've received your order and we're preparing it now. We'll email
                you again as soon as it ships.
              </td>
            </tr>
            <tr>
              <td style="padding:14px 16px;background:#F0EAD6;border-radius:8px;font-size:13px;color:${INK};">
                Order reference <strong>${escapeHtml(d.orderRef)}</strong>
              </td>
            </tr>
            <tr><td style="height:28px;"></td></tr>
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">
                  ${rows}
                  <tr>
                    <td style="padding:16px 0;color:${INK};font-weight:bold;">Total paid</td>
                    <td align="right" style="padding:16px 0;color:${INK};font-weight:bold;">${formatINR(d.total)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding-top:16px;font-size:14px;line-height:1.6;color:${MUTED};">
                <div style="color:${INK};font-weight:bold;margin-bottom:6px;">Delivering to</div>
                ${addressLines(d.address).map(escapeHtml).join("<br>")}
              </td>
            </tr>
            <tr><td style="height:32px;"></td></tr>
            <tr>
              <td style="border-top:1px solid #eee;padding-top:20px;font-size:12px;line-height:1.6;color:${MUTED};">
                Questions about this order? Just reply to this email — it reaches
                us directly.
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

/**
 * The email a customer gets when their photograph is not used.
 *
 * THE HARDEST TONE IN THE CODEBASE, and worth saying why. Every other message
 * this shop sends is about a transaction: an order confirmed, an invoice, a
 * cancellation. This one is about something a person made and offered us, and
 * being turned down for a photograph of yourself is a different kind of small
 * disappointment. So it opens with thanks, gives the actual reason rather than a
 * policy, and ends with an invitation — because the point of telling somebody
 * why is that they can try again, and an email that only says no has spent the
 * goodwill without buying anything.
 *
 * IT IS NEVER SENT WITHOUT A REASON. Migration 0052's CHECK enforces that, and
 * the moderation screen offers silent rejection as a separate action for spam.
 * Nobody receives "your photograph was declined" with nothing after it.
 *
 * Same construction as the other templates: table layout, inline styles, and a
 * text part alongside.
 */

export interface StyleRejectedData {
  customerName: string;
  productName: string;
  /** In the admin's own words. Shown as written — see the escaping below. */
  reason: string;
  /** Where to go to send another. */
  ordersUrl: string;
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

export function styleRejectedSubject(productName: string): string {
  // Not "rejected" and not "declined". The subject line is read in a list, out
  // of context, and it should not land as a verdict before the email is opened.
  return `About the photograph you sent us — ${productName}`;
}

export function styleRejectedText(d: StyleRejectedData): string {
  return [
    `Hello ${d.customerName},`,
    "",
    `Thank you for sending us a photograph of your ${d.productName} — it means a lot that you took the time.`,
    "",
    "We're not able to use this one:",
    `  ${d.reason}`,
    "",
    "If you'd like to send another, you can do it from your orders page — we'd genuinely love to see it.",
    d.ordersUrl,
    "",
    "Nothing about your order is affected by this.",
    "",
    "THE WOVENNE",
  ].join("\n");
}

export function styleRejectedHtml(d: StyleRejectedData): string {
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
                Thank you for sending us your photograph.
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px;font-size:15px;line-height:1.6;color:${MUTED};">
                Hello ${escapeHtml(d.customerName)} — you sent us a photograph of
                your <strong style="color:${INK};">${escapeHtml(d.productName)}</strong>,
                and it means a lot that you took the time.
              </td>
            </tr>
            <tr>
              <td style="padding:14px 16px;background:#F0EAD6;border-radius:8px;font-size:14px;line-height:1.7;color:${INK};">
                We&rsquo;re not able to use this one:
                <br>
                <span style="color:${MUTED};">${escapeHtml(d.reason)}</span>
              </td>
            </tr>
            <tr><td style="height:24px;"></td></tr>
            <tr>
              <td style="font-size:15px;line-height:1.6;color:${MUTED};">
                If you&rsquo;d like to send another, you can do it from your orders
                page — we&rsquo;d genuinely love to see it.
              </td>
            </tr>
            <tr><td style="height:20px;"></td></tr>
            <tr>
              <td>
                <a href="${d.ordersUrl}"
                   style="display:inline-block;background:${TERRACOTTA};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:14px;">
                  Send another photograph
                </a>
              </td>
            </tr>
            <tr><td style="height:32px;"></td></tr>
            <tr>
              <td style="border-top:1px solid #eee;padding-top:20px;font-size:12px;line-height:1.6;color:${MUTED};">
                Nothing about your order is affected by this. If you&rsquo;d like to
                talk it through, just reply — it reaches us directly.
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

/**
 * The email a customer gets when their photograph is not used (rebuilt on the
 * E1 layout in WP-EMAIL-E5).
 *
 * THE HARDEST TONE IN THE CODEBASE. Every other message this shop sends is
 * about a transaction. This one is about something a person made and offered
 * us. So it opens with thanks, gives the actual reason rather than a policy,
 * and ends with an invitation to send another, because the point of telling
 * somebody why is that they can try again.
 *
 * IT IS NEVER SENT WITHOUT A REASON. Migration 0052's CHECK enforces that, and
 * the moderation screen offers silent rejection separately for spam.
 *
 * THE INVITATION IS REAL. A rejected, not-withdrawn submission can be replaced
 * from the orders page (ShareYourStyle → /api/style/submit → resubmit_style,
 * 0073), so the button goes there. The link is a fixed first-party path
 * through the layout's safeHref: no environment variable, so a preview
 * deployment can never put its own host into a customer's inbox.
 *
 * No reply-to promise: whether replies are read is not something this code
 * can vouch for.
 */
import {
  CLOSING_TEXT,
  EMAIL_ORIGIN,
  button,
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
} from "./layout";
import { customerVisibleText, greetingName } from "./greetingName";

export interface StyleRejectedData {
  customerName: string | null;
  productName: string | null;
  /** In the admin's own words, as recorded. Shown escaped and capped. */
  reason: string;
}

/** Where a customer replaces a turned-down photograph. */
export const STYLE_RESUBMIT_PATH = "/in/account/orders";
export const STYLE_REASON_MAX = 500;

const FOOTER: EmailFooter = { kind: "transactional" };

function product(name: string | null): string {
  return String(name ?? "").replace(/[\r\n\t]+/g, " ").trim() || "your piece";
}

export function styleRejectedSubject(productName: string | null): string {
  // Not "rejected" and not "declined". The subject line is read in a list, out
  // of context, and it should not land as a verdict before the email is opened.
  return `About the photograph you sent us — ${product(productName)}`;
}

function parts(d: StyleRejectedData) {
  const reason = customerVisibleText(d.reason, STYLE_REASON_MAX);
  if (!reason) throw new TypeError("A rejection email needs a reason.");
  const p = product(d.productName);
  const named = p !== "your piece";
  return {
    product: p,
    named,
    preheader: `Thank you for your photograph${named ? ` of the ${p}` : ""}. We can't use this one, and here is why.`,
    thanks: named
      ? `You sent us a photograph of your ${p}, and we're grateful you took the time.`
      : "You sent us a photograph of your piece, and we're grateful you took the time.",
    notUsing: "We're not able to use this one:",
    reason,
    invite: "If you'd like to send another, you can do it from your orders page. We'd love to see it.",
    unaffected: "Nothing about your order is affected by this.",
  };
}

export function styleRejectedHtml(d: StyleRejectedData): string {
  const p = parts(d);
  return renderEmail({
    title: styleRejectedSubject(d.productName),
    preheader: p.preheader,
    body: [
      heading("Thank you for your photograph"),
      greeting(greetingName(d.customerName)),
      paragraph(
        p.named
          ? html`You sent us a photograph of your ${strong(p.product)}, and we're grateful you took the time.`
          : p.thanks
      ),
      infoBox(html`${p.notUsing}<br>${p.reason}`),
      paragraph(p.invite),
      button({ href: STYLE_RESUBMIT_PATH, label: "Send another photograph" }),
      paragraph(p.unaffected, { tone: "small" }),
      closing(),
    ],
    footer: FOOTER,
  });
}

export function styleRejectedText(d: StyleRejectedData): string {
  const p = parts(d);
  return [
    "Thank you for your photograph",
    "",
    greetingText(greetingName(d.customerName)),
    "",
    p.thanks,
    "",
    p.notUsing,
    p.reason,
    "",
    p.invite,
    `Send another photograph: ${EMAIL_ORIGIN}${STYLE_RESUBMIT_PATH}`,
    "",
    p.unaffected,
    "",
    CLOSING_TEXT,
    "",
    "--",
    footerText(FOOTER),
  ].join("\n");
}

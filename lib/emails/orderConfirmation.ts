import { formatINR } from "../utils";
import type { ShippingAddress } from "../orderDetails";
import {
  EMAIL_COLORS,
  CLOSING_TEXT,
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
  safeHref,
  strong,
  type EmailFooter,
  type SafeHtml,
} from "./layout";

/**
 * The email a customer gets after paying (WP-EMAIL-E2).
 *
 * Built on the shared layout (lib/emails/layout.ts), so it carries the emblem,
 * wordmark and tagline of the approved r4 email, escapes every value, and only
 * links to the shop. A text part is always sent alongside.
 *
 * WHAT IT DOES NOT SAY, AND WHY:
 * - Nothing about a shipping email. None exists yet (WP-EMAIL-E3); the old copy
 *   promised one. It says the order is being prepared, which is true.
 * - Nothing about replies reaching anyone. The transactional footer points to
 *   the contact details on the website instead.
 * - No invoice number, payment method, dates or tracking: not passed in, so
 *   not shown. Every fact here comes from the order row as recorded.
 * - No breakdown that does not add up. Subtotal, delivery and discounts appear
 *   only when the stored figures reconcile exactly with the total paid
 *   (breakdownOf); otherwise "Total paid" stands alone.
 *
 * THE "VIEW YOUR ORDER" BUTTON is only for a customer who can actually see the
 * order: an account whose confirmed email is the order's email (the same rule
 * as the "Customers read own orders" RLS policy). The caller decides that and
 * passes `accountOrdersHref`; without it, guests get the confirmation without
 * a link that would only lead them to a sign-in page for an account they do
 * not have.
 */

export interface OrderEmailItem {
  name: string;
  size: string;
  quantity: number;
  price_inr: number;
}

export interface OrderEmailData {
  orderRef: string;
  /** As recorded on the order. May be empty or odd; see greetingName. */
  customerName: string | null;
  items: OrderEmailItem[];
  /** orders.total_inr: what Razorpay captured. Null or invalid → not shown. */
  total: number | null;
  address: ShippingAddress;
  /**
   * The server-computed adjustments stored on the order at checkout. Shown as
   * a breakdown only when they reconcile exactly with the total paid; see
   * breakdownOf.
   */
  adjustments?: OrderAdjustments | null;
  /**
   * A path to the customer's orders page, only when they can see this order
   * there. Omitted for guests and whenever eligibility could not be confirmed.
   */
  accountOrdersHref?: string | null;
}

export interface OrderAdjustments {
  /** orders.shipping_cost_inr */
  shipping?: number | null;
  /** orders.coupon_code */
  couponCode?: string | null;
  /** orders.coupon_discount_inr */
  couponDiscount?: number | null;
  /** orders.loyalty_discount_inr */
  loyaltyDiscount?: number | null;
}

/** The path the button uses. A constant so the caller cannot pass anything else by mistake. */
export const ACCOUNT_ORDERS_PATH = "/in/account/orders";

const FOOTER: EmailFooter = { kind: "transactional" };
const RECEIVED = "We've received your order and we're preparing it now.";
const GUEST_LINE = "Please keep this email: it is your receipt for this order.";
const ACCOUNT_LINE =
  "You can follow your order's progress in your account, signed in with this email address.";

/**
 * The name to greet, or null for "Hello,".
 *
 * Checkout takes the name as typed, so it can be blank, an email address, a
 * string of digits, or something long pasted by mistake. Only something that
 * looks like a name is used; the greeting then takes its first word.
 */
export function greetingName(name: string | null | undefined): string | null {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!n || n.length > 80) return null;
  if (n.includes("@") || /https?:|www\./i.test(n)) return null;
  if (!/\p{L}/u.test(n)) return null;
  const first = n.split(" ")[0];
  if (first.length > 40 || !/\p{L}/u.test(first)) return null;
  return n;
}

/** Only well-formed lines; nothing recomputed beyond quantity × unit price. */
interface CleanItem {
  name: string;
  size: string | null;
  quantity: number | null;
  lineTotal: number | null;
}

function cleanItems(items: unknown): CleanItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => {
      const quantity = Number(i.quantity);
      const price = Number(i.price_inr);
      const qOk = Number.isInteger(quantity) && quantity > 0;
      const size = typeof i.size === "string" ? i.size.trim() : "";
      return {
        name: String(i.name ?? "").trim() || "Item",
        size: size && size !== "One Size" ? size : null,
        quantity: qOk ? quantity : null,
        lineTotal: qOk && Number.isFinite(price) && price >= 0 ? price * quantity : null,
      };
    });
}

function addressLines(a: ShippingAddress | null | undefined): string[] {
  if (!a || typeof a !== "object") return [];
  return [a.line1, a.line2, a.city, a.state, a.postal_code, a.country]
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter((l) => l.length > 0);
}

function totalOf(d: OrderEmailData): number | null {
  // Null must stay null: Number(null) is 0, and "Total paid ₹0" would be invented.
  if (d.total === null || d.total === undefined) return null;
  const t = Number(d.total);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

/**
 * Rupees, with paise only when there are any. formatINR rounds to the rupee,
 * which is right for whole amounts and would misstate a fractional one.
 */
function money(n: number): string {
  if (Number.isInteger(n)) return formatINR(n);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

interface BreakdownRow {
  label: string;
  amount: string;
}

/**
 * Subtotal, delivery and discounts, or null to show the total alone.
 *
 * Every figure is a stored, server-computed value, and none is recalculated
 * from the others. The rows are shown ONLY when they add up exactly, to the
 * paisa, to the total Razorpay captured: every line priced, every adjustment
 * a valid non-negative number, and subtotal − coupon + delivery − points =
 * total. Anything else (a missing line price, the ₹1 payment floor, a row
 * written before a column existed) shows "Total paid" on its own, which is
 * always true. With no delivery charge and no discount the subtotal would just
 * repeat the total, so there is no breakdown then either.
 */
function breakdownOf(items: CleanItem[], total: number | null, adj: OrderAdjustments | null | undefined): BreakdownRow[] | null {
  if (total === null || !items.length || !adj) return null;
  if (items.some((i) => i.lineTotal === null)) return null;
  const amt = (v: unknown): number | null => {
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const shipping = amt(adj.shipping);
  const coupon = amt(adj.couponDiscount);
  const points = amt(adj.loyaltyDiscount);
  if (shipping === null || coupon === null || points === null) return null;
  if (shipping === 0 && coupon === 0 && points === 0) return null;
  const subtotal = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const paise = (n: number) => Math.round(n * 100);
  if (paise(subtotal) - paise(coupon) + paise(shipping) - paise(points) !== paise(total)) return null;

  const code = typeof adj.couponCode === "string" ? adj.couponCode.trim().slice(0, 40) : "";
  return [
    { label: "Subtotal", amount: money(subtotal) },
    ...(coupon > 0 ? [{ label: code ? `Discount (${code})` : "Discount", amount: `−${money(coupon)}` }] : []),
    ...(points > 0 ? [{ label: "Loyalty points", amount: `−${money(points)}` }] : []),
    { label: "Delivery", amount: shipping > 0 ? money(shipping) : "Free" },
  ];
}

/**
 * The button's target, or null. Only the fixed account-orders path is
 * accepted, so a mistaken caller cannot point the button anywhere else.
 */
function orderLink(d: OrderEmailData): string | null {
  return d.accountOrdersHref === ACCOUNT_ORDERS_PATH ? safeHref(ACCOUNT_ORDERS_PATH) : null;
}

export function orderConfirmationSubject(orderRef: string): string {
  // The reference goes in the subject so a customer searching their inbox for
  // it finds the mail, which is what people actually do. Unchanged by E2.
  return `Your THE WOVENNE order — ${orderRef}`;
}

export function orderConfirmationText(d: OrderEmailData): string {
  const items = cleanItems(d.items);
  const total = totalOf(d);
  const address = addressLines(d.address);
  const link = orderLink(d);
  const breakdown = breakdownOf(items, total, d.adjustments);
  return [
    greetingText(greetingName(d.customerName)),
    "",
    `Thank you for your order. ${RECEIVED}`,
    "",
    `Order reference: ${d.orderRef}`,
    ...(items.length
      ? [
          "",
          "What you ordered:",
          ...items.map(
            (i) =>
              `- ${i.name}${i.size ? ` (${i.size})` : ""}${i.quantity ? ` x${i.quantity}` : ""}${
                i.lineTotal !== null ? ` — ${money(i.lineTotal)}` : ""
              }`
          ),
        ]
      : []),
    ...(breakdown ? ["", ...breakdown.map((r) => `${r.label}: ${r.amount}`)] : []),
    ...(total !== null ? [...(breakdown ? [] : [""]), `Total paid: ${money(total)}`] : []),
    ...(address.length ? ["", "Delivering to:", ...address] : []),
    "",
    link ? `${ACCOUNT_LINE}\nView your order: ${link}` : GUEST_LINE,
    "",
    CLOSING_TEXT,
    "",
    footerText(FOOTER),
  ].join("\n");
}

/**
 * Style constants are interpolated like any other value, so they are escaped
 * too; they contain none of & < > " ' and come out unchanged. Nothing here
 * needs to bypass escaping.
 */
const CELL = `padding:12px 0;border-bottom:1px solid ${EMAIL_COLORS.rule};font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:${EMAIL_COLORS.ink};`;

const SUM_CELL = `padding:8px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:${EMAIL_COLORS.muted};`;

function itemsSection(items: CleanItem[], total: number | null, breakdown: BreakdownRow[] | null): SafeHtml | null {
  if (!items.length && total === null) return null;
  const rows = items.map(
    (i) => html`<tr>
              <td style="${CELL}">${i.name}${
                i.size ? html`<span style="color:${EMAIL_COLORS.muted};"> · ${i.size}</span>` : ""
              }${i.quantity ? html`<span style="color:${EMAIL_COLORS.muted};"> × ${i.quantity}</span>` : ""}</td>
              <td align="right" style="${CELL}white-space:nowrap;padding-left:12px;">${
                i.lineTotal !== null ? money(i.lineTotal) : ""
              }</td>
            </tr>`
  );
  const sumRows = (breakdown ?? []).map(
    (r) => html`<tr>
              <td style="${SUM_CELL}">${r.label}</td>
              <td align="right" style="${SUM_CELL}white-space:nowrap;padding-left:12px;">${r.amount}</td>
            </tr>`
  );
  const totalRow =
    total !== null
      ? html`<tr>
              <td style="padding:16px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;color:${EMAIL_COLORS.ink};">Total paid</td>
              <td align="right" style="padding:16px 0 16px 12px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;white-space:nowrap;color:${EMAIL_COLORS.ink};">${money(total)}</td>
            </tr>`
      : "";
  return html`<tr><td style="padding-bottom:16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${rows}${sumRows}${totalRow}
          </table>
        </td></tr>`;
}

function addressSection(lines: string[]): SafeHtml | null {
  if (!lines.length) return null;
  return html`<tr><td style="padding-bottom:24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:${EMAIL_COLORS.muted};">
          <div style="color:${EMAIL_COLORS.ink};font-weight:bold;margin-bottom:6px;">Delivering to</div>
          ${lines.map((l, idx) => html`${idx ? html`<br>` : ""}${l}`)}
        </td></tr>`;
}

export function orderConfirmationHtml(d: OrderEmailData): string {
  const items = cleanItems(d.items);
  const total = totalOf(d);
  const link = orderLink(d);
  const sections = [
    heading("Thank you for your order"),
    greeting(greetingName(d.customerName)),
    paragraph(RECEIVED),
    infoBox(html`Order reference ${strong(d.orderRef)}`),
    itemsSection(items, total, breakdownOf(items, total, d.adjustments)),
    addressSection(addressLines(d.address)),
    ...(link
      ? [paragraph(ACCOUNT_LINE, { spaceAfter: 16 }), button({ href: ACCOUNT_ORDERS_PATH, label: "View your order" })]
      : [paragraph(GUEST_LINE)]),
    closing(),
  ].filter((s): s is SafeHtml => s !== null);

  return renderEmail({
    title: orderConfirmationSubject(d.orderRef),
    preheader: `${RECEIVED} Order reference ${d.orderRef}.`,
    body: sections,
    footer: FOOTER,
  });
}

import { orderRef } from "./orders";

/**
 * Invoice data, shaped from an order row.
 *
 * RENDERED ON DEMAND, NOT STORED. Every figure comes from the order itself:
 * `items` is a snapshot written at payment, and `total_inr` is what Razorpay
 * actually captured. Neither moves afterwards — admins edit courier and status,
 * not amounts — so rendering the same order twice produces the same document,
 * and there are no PDFs to store, back up, or backfill.
 *
 * The invoice NUMBER is the exception: it is allocated once, in the database,
 * when the order is first marked paid (migration 0037). A document without one
 * is not an invoice, so this refuses to build one.
 */

export const BUSINESS = {
  name: "THE WOVENNE",
  lines: ["Anns Building", "Kidangara", "Alappuzha", "Kerala 686102", "India"],
  // Populated at GST registration. Until then the tax block is omitted
  // entirely rather than printed as zeroes, because a line reading "GST ₹0"
  // on an invoice from an unregistered business is a claim, not a formality.
  gstin: null as string | null,
} as const;

export interface InvoiceLine {
  name: string;
  size: string;
  quantity: number;
  price_inr: number;
  /** Null until GST registration. */
  hsn_code?: string | null;
}

export interface InvoiceData {
  invoiceNumber: string;
  issuedAt: string;
  orderReference: string;
  orderDate: string;
  customer: { name: string; email: string; phone: string | null };
  address: Record<string, string> | null;
  lines: InvoiceLine[];
  /** Goods before any discount. */
  subtotal: number;
  couponCode: string | null;
  couponDiscount: number;
  loyaltyDiscount: number;
  loyaltyPoints: number;
  shipping: number;
  /** What was actually charged. */
  total: number;
  payment: { provider: string; reference: string | null; status: string };
  /** Null until GST registration — see BUSINESS.gstin. */
  tax: { label: string; amount: number }[] | null;
}

interface OrderRowLike {
  id: string;
  invoice_number: string | null;
  invoice_issued_at: string | null;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  shipping_address: Record<string, string> | null;
  items: unknown;
  total_inr: number | null;
  shipping_cost_inr: number | null;
  coupon_code?: string | null;
  coupon_discount_inr?: number | null;
  loyalty_discount_inr?: number | null;
  loyalty_points_spent?: number | null;
  payment_provider: string | null;
  payment_status: string | null;
  razorpay_order_id: string | null;
  tax?: unknown;
}

export function buildInvoice(order: OrderRowLike): InvoiceData | null {
  if (!order.invoice_number) return null;

  const rawItems = Array.isArray(order.items) ? order.items : [];
  const lines: InvoiceLine[] = rawItems.map((i) => {
    const item = i as Partial<InvoiceLine>;
    return {
      name: String(item.name ?? "Item"),
      size: String(item.size ?? ""),
      quantity: Number(item.quantity ?? 0),
      price_inr: Number(item.price_inr ?? 0),
      hsn_code: item.hsn_code ?? null,
    };
  });

  const subtotal = lines.reduce((sum, l) => sum + l.price_inr * l.quantity, 0);

  // The tax block stays null while BUSINESS.gstin is null. Structurally the
  // renderer already has a place for it, so registering later is populating
  // this array rather than rebuilding the document.
  const tax =
    BUSINESS.gstin && Array.isArray(order.tax)
      ? (order.tax as { label: string; amount: number }[])
      : null;

  return {
    invoiceNumber: order.invoice_number,
    issuedAt: order.invoice_issued_at ?? order.created_at,
    // The Razorpay id is the reference a customer or a bank would quote, so an
    // online order still prints that. AN IN-PERSON ORDER HAS NONE, and the
    // fallback used to be the raw uuid — which printed
    // "a53c16f7-b5d3-48e5-b825-ed84aa335d59", wrapped onto two lines, and
    // matched nothing else the customer had ever been shown. Their email, their
    // order page and the admin all use the short reference, so the document that
    // goes into their records should quote the same thing.
    orderReference: order.razorpay_order_id ?? orderRef(order.id),
    orderDate: order.created_at,
    customer: {
      name: order.customer_name ?? "",
      email: order.customer_email ?? "",
      phone: order.customer_phone ?? null,
    },
    address: order.shipping_address ?? null,
    lines,
    subtotal,
    couponCode: order.coupon_code ?? null,
    couponDiscount: Number(order.coupon_discount_inr ?? 0),
    loyaltyDiscount: Number(order.loyalty_discount_inr ?? 0),
    loyaltyPoints: Number(order.loyalty_points_spent ?? 0),
    shipping: Number(order.shipping_cost_inr ?? 0),
    total: Number(order.total_inr ?? 0),
    payment: {
      provider: order.payment_provider ?? "razorpay",
      reference: order.razorpay_order_id,
      status: order.payment_status ?? "pending",
    },
    tax,
  };
}

/** The columns buildInvoice needs. Kept here so the route cannot drift from it. */
export const INVOICE_SELECT =
  "id, invoice_number, invoice_issued_at, created_at, customer_name, customer_email, " +
  "customer_phone, shipping_address, items, total_inr, shipping_cost_inr, coupon_code, " +
  "coupon_discount_inr, loyalty_discount_inr, loyalty_points_spent, payment_provider, " +
  "payment_status, razorpay_order_id, tax";

/**
 * "INR 8,900" — Indian digit grouping, no decimals.
 *
 * NOT the ₹ symbol, and this is the one place in the shop that does not use it.
 * PDF's built-in fonts are Latin-1 and have no glyph at U+20B9, so ₹ renders as
 * a stray mark next to the number — verified, it prints as `'8,900`. A wrong
 * currency mark on a financial record is worse than a plain one.
 *
 * To restore the symbol, drop a TTF that includes U+20B9 into public/ and
 * register it with @react-pdf/renderer's Font.register, then change this back.
 * That is a font-licensing decision, not a code one, which is why it is not
 * made here.
 */
export function inr(amount: number): string {
  return `INR ${Math.round(amount).toLocaleString("en-IN")}`;
}

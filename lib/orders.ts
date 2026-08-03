import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShippingAddress } from "./orderDetails";

/**
 * Orders, for the admin and for the customer's own history.
 *
 * Fulfilment status is separate from payment status throughout: they answer
 * different questions, and a refunded-but-delivered order needs somewhere to
 * sit.
 */

export type OrderStatus =
  | "placed"
  | "confirmed"
  | "shipped"
  | "delivered"
  | "cancelled";

/**
 * The order a customer sees. Cancelled is deliberately outside it — it is an
 * exit, not a step, and drawing it on the line would imply every order passes
 * through it.
 */
export const STATUS_FLOW: OrderStatus[] = [
  "placed",
  "confirmed",
  "shipped",
  "delivered",
];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: "Placed",
  confirmed: "Confirmed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/**
 * What each status means, in the customer's terms.
 *
 * Deliberately vague about courier movement: we know when a parcel was handed
 * over, not where it is. Saying "out for delivery" without that data would be
 * inventing it.
 */
export const STATUS_BLURB: Record<OrderStatus, string> = {
  placed: "We've received your order and are confirming payment.",
  confirmed: "Payment confirmed. We're preparing your order for dispatch.",
  shipped: "On its way. Track it with the number below.",
  delivered: "Delivered. We hope you love it.",
  cancelled: "This order was cancelled. Any payment has been refunded.",
};

export interface OrderItem {
  id: string;
  name: string;
  size: string;
  quantity: number;
  price_inr: number;
}

export interface Order {
  id: string;
  created_at: string;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  shipping_address: ShippingAddress | null;
  items: OrderItem[];
  total_inr: number;
  shipping_cost_inr: number;
  payment_provider: string | null;
  payment_status: string;
  status: OrderStatus;
  needs_review: boolean;
  courier_name: string | null;
  awb_number: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  admin_note: string | null;
  razorpay_order_id: string | null;
}

const ORDER_SELECT =
  "id, created_at, customer_email, customer_name, customer_phone, " +
  "shipping_address, items, total_inr, shipping_cost_inr, payment_provider, " +
  "payment_status, status, needs_review, courier_name, awb_number, " +
  "shipped_at, delivered_at, admin_note, razorpay_order_id";

function mapOrder(row: Record<string, unknown>): Order {
  return {
    ...(row as unknown as Order),
    items: Array.isArray(row.items) ? (row.items as OrderItem[]) : [],
    total_inr: Number(row.total_inr ?? 0),
    shipping_cost_inr: Number(row.shipping_cost_inr ?? 0),
  };
}

/**
 * Every order, newest first — admin only.
 *
 * Flagged orders are not floated to the top: an admin scanning a list expects
 * it in the order they were placed, and a row that jumps position is easy to
 * process twice. They are marked instead.
 */
export async function getAllOrders(client: SupabaseClient): Promise<Order[]> {
  const { data, error } = await client
    .from("orders")
    .select(ORDER_SELECT)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getAllOrders:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapOrder);
}

/**
 * The signed-in customer's own orders.
 *
 * No email filter here: the RLS policy from 0023 matches on auth.email() from
 * the JWT. Filtering as well would suggest the policy were optional, and the
 * one that matters is the one the database enforces.
 */
export async function getMyOrders(client: SupabaseClient): Promise<Order[]> {
  const { data, error } = await client
    .from("orders")
    .select(ORDER_SELECT)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getMyOrders:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapOrder);
}

/** A short, readable reference. The first block of the uuid, as in the email. */
export function orderRef(id: string): string {
  return id.split("-")[0].toUpperCase();
}

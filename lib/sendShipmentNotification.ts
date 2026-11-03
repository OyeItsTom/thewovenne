import { createServiceClient } from "./supabase";
import { INDIA_POST_LABEL } from "./couriers/indiaPost";
import {
  shipmentNotificationHtml,
  shipmentNotificationSubject,
  shipmentNotificationText,
} from "./emails/shipmentNotification";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type RenderedShipment =
  | { ok: true; subject: string; html: string; text: string }
  | {
      ok: false;
      retryable: boolean;
      reason: "order_load_failed" | "order_missing" | "order_cancelled" | "not_dispatched" | "invalid_dispatch" | "render_failed";
    };

/**
 * Render the shipping email for one dispatched order (WP-EMAIL-E3b).
 *
 * Built from the order as stored, at the moment of the first attempt, and
 * then frozen by R1 like any other delivery. Refuses — so nothing is sent —
 * when the order was cancelled after dispatch, is not (or no longer)
 * dispatched, or carries a courier or consignment that dispatch_order would
 * not have written. The recipient is the one frozen on the delivery row.
 * Never throws.
 */
export async function renderShipmentNotification(
  orderId: string,
  _recipient: string,
  deps?: { supabase?: ServiceClient }
): Promise<RenderedShipment> {
  try {
    const supabase = deps?.supabase ?? createServiceClient();
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer_name, status, courier_name, awb_number")
      .eq("id", orderId)
      .maybeSingle();
    if (error) {
      console.error(`Shipping email: could not load order ${orderId}: ${error.message}`);
      return { ok: false, retryable: true, reason: "order_load_failed" };
    }
    if (!data) return { ok: false, retryable: false, reason: "order_missing" };

    const order = data as {
      id: string;
      customer_name: string | null;
      status: string | null;
      courier_name: string | null;
      awb_number: string | null;
    };
    if (order.status === "cancelled") return { ok: false, retryable: false, reason: "order_cancelled" };
    if (order.status !== "shipped" && order.status !== "delivered") {
      return { ok: false, retryable: false, reason: "not_dispatched" };
    }
    const consignment = String(order.awb_number ?? "");
    if (order.courier_name !== INDIA_POST_LABEL || !/^[A-Z0-9]{1,30}$/.test(consignment)) {
      return { ok: false, retryable: false, reason: "invalid_dispatch" };
    }

    const data2 = {
      orderRef: String(order.id).split("-")[0].toUpperCase(),
      customerName: order.customer_name,
      consignment,
    };
    return {
      ok: true,
      subject: shipmentNotificationSubject(data2.orderRef),
      html: shipmentNotificationHtml(data2),
      text: shipmentNotificationText(data2),
    };
  } catch (e) {
    console.error(`Shipping email for ${orderId} could not be rendered:`, e instanceof Error ? e.message : "unknown");
    return { ok: false, retryable: false, reason: "render_failed" };
  }
}

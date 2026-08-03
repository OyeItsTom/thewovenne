import { createServiceClient } from "./supabase";
import { sendEmail } from "./email";
import {
  orderConfirmationHtml,
  orderConfirmationSubject,
  orderConfirmationText,
  type OrderEmailItem,
} from "./emails/orderConfirmation";
import { EMPTY_ADDRESS, type ShippingAddress } from "./orderDetails";

/**
 * Send the confirmation for a paid order.
 *
 * Reads the order back from the database rather than taking it from the
 * request, so the email says what was actually recorded. If the two ever
 * disagree, the customer should see the version we will ship from.
 */
export async function sendOrderConfirmation(
  razorpayOrderId: string
): Promise<void> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, customer_email, customer_name, items, total_inr, shipping_address")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();

  if (error || !data) {
    console.error(
      `Order confirmation: could not load ${razorpayOrderId}: ${error?.message ?? "no row"}`
    );
    return;
  }

  const order = data as {
    id: string;
    customer_email: string | null;
    customer_name: string | null;
    items: OrderEmailItem[] | null;
    total_inr: number | null;
    shipping_address: ShippingAddress | null;
  };

  if (!order.customer_email) {
    // Pre-0020 orders, and the rare paid-with-no-pending-row case. Nothing to
    // send to; the order itself is already flagged for review.
    console.error(`Order ${order.id} has no email — no confirmation sent.`);
    return;
  }

  // The first block of the uuid is short enough to read down a phone and long
  // enough to be unambiguous at this volume.
  const orderRef = order.id.split("-")[0].toUpperCase();

  const result = await sendEmail({
    to: order.customer_email,
    subject: orderConfirmationSubject(orderRef),
    html: orderConfirmationHtml({
      orderRef,
      customerName: order.customer_name || "there",
      items: order.items ?? [],
      total: Number(order.total_inr ?? 0),
      address: order.shipping_address ?? EMPTY_ADDRESS,
    }),
    text: orderConfirmationText({
      orderRef,
      customerName: order.customer_name || "there",
      items: order.items ?? [],
      total: Number(order.total_inr ?? 0),
      address: order.shipping_address ?? EMPTY_ADDRESS,
    }),
  });

  if (!result.ok) {
    console.error(`Order ${order.id}: confirmation not sent — ${result.error}`);
  }
}

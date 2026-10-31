import { createServiceClient } from "./supabase";
import { sendEmail } from "./email";
import {
  ACCOUNT_ORDERS_PATH,
  orderConfirmationHtml,
  orderConfirmationSubject,
  orderConfirmationText,
  type OrderEmailItem,
} from "./emails/orderConfirmation";
import { EMPTY_ADDRESS, type ShippingAddress } from "./orderDetails";
import { exactEmailPattern } from "./orders";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Can somebody signed in see this order on their orders page?
 *
 * The orders page shows an order to the account whose auth email equals the
 * order's email (RLS "Customers read own orders": lower(customer_email) =
 * lower(auth.email()), and getMyOrders filters the same way). So the answer is
 * yes only for a confirmed, not-banned Auth user whose own email matches.
 *
 * profiles.email finds the candidates (the same lookup loyalty uses), but it
 * is not trusted on its own: a customer can update that column. Each candidate
 * is confirmed against Supabase Auth itself.
 *
 * Any error or doubt answers false. The cost is a guest-style email for an
 * account holder; the alternative would be a button to a page that shows them
 * nothing. Never throws.
 */
export async function accountCanViewOrder(
  supabase: ServiceClient,
  orderEmail: string
): Promise<boolean> {
  // Compared exactly as the policy does, lower() on both sides and no trim:
  // an order email the policy would not match must not get the button.
  const email = String(orderEmail ?? "").toLowerCase();
  if (!email.trim()) return false;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", exactEmailPattern(email))
      .limit(5);
    if (error || !Array.isArray(data)) return false;

    const ids = (data as { id?: unknown }[])
      .map((row) => row?.id)
      .filter((id): id is string => typeof id === "string");

    // In parallel, so several candidates cost one round trip, not several.
    const verdicts = await Promise.all(
      ids.map(async (id) => {
        try {
          const { data: auth, error: authError } = await supabase.auth.admin.getUserById(id);
          const user = auth?.user;
          if (authError || !user) return false;
          const banned =
            typeof user.banned_until === "string" && Date.parse(user.banned_until) > Date.now();
          return (
            (user.email ?? "").toLowerCase() === email && !!user.email_confirmed_at && !banned
          );
        } catch {
          return false;
        }
      })
    );
    return verdicts.includes(true);
  } catch (e) {
    console.error("Order confirmation: account check failed, sending without the order link:", e);
    return false;
  }
}

/**
 * How long the account check may take before the email goes out without the
 * button. settleOrder does not await this send (see its comment), so it can
 * still be running after the customer's response has gone; the check must not
 * hold the send back for long. The lookups are not cancelled, only ignored.
 */
export const ELIGIBILITY_DEADLINE_MS = 1500;

async function withinDeadline(check: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      console.error(`Order confirmation: account check took over ${ms} ms, sending without the order link.`);
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([check.then((v) => v === true, () => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ConfirmationDeps {
  supabase: ServiceClient;
  send: typeof sendEmail;
  canViewOrder: (supabase: ServiceClient, email: string) => Promise<boolean>;
  /** Overridable for tests only. */
  eligibilityDeadlineMs: number;
}

/**
 * Send the confirmation for a paid order.
 *
 * Reads the order back from the database rather than taking it from the
 * request, so the email says what was actually recorded. If the two ever
 * disagree, the customer should see the version we will ship from.
 *
 * Called by settleOrder only after it has won the confirmation_sent_at claim,
 * so it is attempted at most once per order. Unchanged by E2: the recipient,
 * the subject, the trigger and the never-throw contract. E2 reads four more
 * stored columns (delivery charge, coupon, points) for the breakdown.
 */
export async function sendOrderConfirmation(
  razorpayOrderId: string,
  deps?: Partial<ConfirmationDeps>
): Promise<void> {
  const supabase = deps?.supabase ?? createServiceClient();
  const send = deps?.send ?? sendEmail;
  const canViewOrder = deps?.canViewOrder ?? accountCanViewOrder;
  const deadline = deps?.eligibilityDeadlineMs ?? ELIGIBILITY_DEADLINE_MS;

  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, customer_email, customer_name, items, total_inr, shipping_address, shipping_cost_inr, coupon_code, coupon_discount_inr, loyalty_discount_inr"
    )
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
    shipping_cost_inr?: number | null;
    coupon_code?: string | null;
    coupon_discount_inr?: number | null;
    loyalty_discount_inr?: number | null;
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

  let eligible = false;
  try {
    eligible = await withinDeadline(
      Promise.resolve().then(() => canViewOrder(supabase, order.customer_email as string)),
      deadline
    );
  } catch {
    eligible = false;
  }

  const emailData = {
    orderRef,
    customerName: order.customer_name,
    items: order.items ?? [],
    total: order.total_inr ?? null,
    address: order.shipping_address ?? EMPTY_ADDRESS,
    adjustments: {
      shipping: order.shipping_cost_inr,
      couponCode: order.coupon_code,
      couponDiscount: order.coupon_discount_inr,
      loyaltyDiscount: order.loyalty_discount_inr,
    },
    accountOrdersHref: eligible ? ACCOUNT_ORDERS_PATH : null,
  };

  let html: string;
  let text: string;
  try {
    html = orderConfirmationHtml(emailData);
    text = orderConfirmationText(emailData);
  } catch (e) {
    // The layout refuses unsafe links by throwing. Nothing here passes one,
    // but a rendering fault must not escape into payment settlement.
    console.error(`Order ${order.id}: confirmation could not be rendered — not sent:`, e);
    return;
  }

  const result = await send({
    to: order.customer_email,
    subject: orderConfirmationSubject(orderRef),
    html,
    text,
  });

  if (!result.ok) {
    console.error(`Order ${order.id}: confirmation not sent — ${result.error}`);
  }
}

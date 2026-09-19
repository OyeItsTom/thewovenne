import { createServiceClient } from "./supabase";

/**
 * Move points after a payment has succeeded.
 *
 * Deduct what was redeemed, then award what was earned — in that order, so a
 * customer cannot spend points they only earned on this same order.
 *
 * Never throws. The customer has paid; a problem with points must not fail
 * their confirmation. Anything unexpected flags the order for a human instead,
 * because silently getting someone's balance wrong is worse than an order that
 * needs looking at.
 */
export async function settleLoyalty(
  razorpayOrderId: string,
  deps?: { supabase?: ReturnType<typeof createServiceClient> }
): Promise<void> {
  const supabase = deps?.supabase ?? createServiceClient();

  try {
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer_email, loyalty_points_spent")
      .eq("razorpay_order_id", razorpayOrderId)
      .maybeSingle();

    if (error || !data) return;
    const order = data as {
      id: string;
      customer_email: string | null;
      loyalty_points_spent: number | null;
    };

    const spend = Number(order.loyalty_points_spent ?? 0);
    if (spend > 0 && order.customer_email) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .ilike("email", order.customer_email)
        .eq("is_admin", false)
        .maybeSingle();

      if (profile) {
        const { data: result, error: redeemError } = await supabase.rpc("redeem_loyalty_points", {
          p_user_id: (profile as { id: string }).id,
          p_points: spend,
          p_order_id: order.id,
        });

        // One redemption per order, enforced by loyalty_ledger_one_redemption_
        // per_order (0058). A settlement replayed after the points were
        // already spent hits that index — unique_violation, 23505 — and that
        // is the guard doing its job, not a balance problem: nothing to flag.
        const alreadyRedeemed = redeemError?.code === "23505";

        // The balance can move between checkout starting and payment landing.
        // The customer has already been charged the discounted amount, so the
        // order is flagged rather than the difference being taken back.
        if (!alreadyRedeemed && !(result as { ok?: boolean } | null)?.ok) {
          console.error(
            `Order ${order.id}: could not redeem ${spend} points — flagging for review.`
          );
          await supabase
            .from("orders")
            .update({ needs_review: true })
            .eq("id", order.id);
        }
      }
    }

    // Awarding is guarded by a unique index, so a repeated call is a no-op
    // rather than a second payout.
    await supabase.rpc("award_loyalty_points", { p_order_id: order.id });
  } catch (e) {
    console.error("settleLoyalty threw:", e);
  }
}

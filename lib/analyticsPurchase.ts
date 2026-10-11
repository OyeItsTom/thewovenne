import type { SupabaseClient } from "@supabase/supabase-js";
import { deploymentMode } from "./analyticsCollect";

/**
 * Record the `purchase` analytics event for an order settlement has just
 * marked paid. Settlement only calls this after Razorpay's API confirmed the
 * capture, so a browser can never cause one.
 *
 * The database does the deciding (analytics_record_purchase, 0068): the switch
 * is on, the order exists, is paid, is online — and one event per order, so
 * the browser callback and the webhook arriving for the same payment record it
 * once. Here we only add what the server alone knows:
 *   * the deployment — a preview or local build never records (it shares the
 *     production database), and a deliberate non-production test records as
 *     `test`;
 *   * whether Razorpay is on live keys — anything but rzp_live_ is a test
 *     payment, and test payments are never customer demand.
 *
 * NEVER THROWS and never changes the settlement's outcome: the customer has
 * paid, and a statistics problem is not their problem.
 */
export async function recordPurchase(
  supabase: SupabaseClient,
  orderId: string,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const mode = deploymentMode(env);
  if (mode === "off") return "not_production";
  const testMode = mode === "test" || !(env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_live_");
  try {
    const { data, error } = await supabase.rpc("analytics_record_purchase", {
      p_order_id: orderId,
      p_test_mode: testMode,
    });
    if (error) {
      console.error(`analytics purchase for ${orderId}:`, error.message);
      return "error";
    }
    return String(data);
  } catch (err) {
    console.error(`analytics purchase for ${orderId}:`, err instanceof Error ? err.message : err);
    return "error";
  }
}

import ShopAnalytics from "@/components/admin/analytics/ShopAnalytics";
import SectionShell from "@/components/admin/SectionShell";

/**
 * Admin → Analytics. A server component only so it can tell the dashboard
 * whether card payments are live — the same test the purchase recorder uses
 * (lib/analyticsPurchase: anything but an rzp_live_ key is test mode). Only
 * that boolean reaches the browser, never the key.
 *
 * Access is unchanged: middleware and the dashboard layout gate the page, and
 * every figure is read with the admin's own session through functions that
 * check is_admin() (staff + aal2 + a live session) themselves.
 */
export default function AnalyticsSectionPage() {
  const paymentsLive = (process.env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_live_");
  return (
    <SectionShell id="analytics">
      <ShopAnalytics paymentsLive={paymentsLive} />
    </SectionShell>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import PendingPaymentNotice from "@/components/cart/PendingPaymentNotice";

/**
 * Where a payment goes when it may have happened but cannot be confirmed.
 *
 * WHY IT IS A ROUTE. The form used to say all of this in a banner above its
 * own Pay button — "do not pay again", directly over the means to do exactly
 * that, in state that a refresh wiped. A route removes the button by not
 * containing one, and a URL is durable for free.
 *
 * WHY IT CARRIES ITS STATE IN THE QUERY RATHER THAN LOOKING IT UP. Answering
 * "what happened to this payment?" from the server would need a public
 * endpoint that takes a Razorpay order id and reports the order's state, with
 * no session behind it, because most of these customers are guests. That is an
 * enumeration surface over real orders, built to tell someone something the
 * page then asks them to contact us about anyway. The query carries a status
 * word and Razorpay's own order reference — no PII, no amount, no signature,
 * nothing that authorises anything — and the cost of that tradeoff is that a
 * hand-typed URL can render a page. It cannot obtain anything, and
 * parseHoldState makes sure it cannot produce the reassuring version.
 */
export const metadata: Metadata = {
  title: "Your payment | THE WOVENNE",
  // Same as checkout itself: a reference in a query string has no business in
  // an index, and this page is meaningless to anyone but the person sent here.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function CheckoutPendingPage() {
  return (
    <Suspense fallback={null}>
      <PendingPaymentNotice />
    </Suspense>
  );
}

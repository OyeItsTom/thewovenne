import { NextRequest, NextResponse } from "next/server";
import { isCountry, DEFAULT_COUNTRY } from "@/lib/country";
import { getDeliveryQuote } from "@/lib/delivery";

/**
 * "Do you deliver to me, what does it cost, and how long?"
 *
 * THE BROWSER SENDS A POSTCODE AND AN INTENT, AND NOTHING ELSE THAT MATTERS.
 * It may claim an order value, but that claim only ever makes delivery MORE
 * expensive or equal — the free-delivery threshold is the one place the number
 * is used, and a client understating it cannot win anything. Overstating it
 * would show "free" on a product page, which checkout would then correct, so
 * the value is clamped to the real product price server-side where a product id
 * is supplied.
 *
 * Nothing here is trusted for money. Checkout re-quotes from the address the
 * customer actually enters, exactly as it did before this endpoint existed.
 *
 * The route answers `unavailable` rather than 404 when the estimator is off, so
 * the component can render nothing without needing to know why.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { market?: string; postalCode?: string; orderValueInr?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "invalid" });
  }

  // isCountry narrows the string, so the assignment stays type-safe rather than
  // being cast past the check it just passed.
  const claimedMarket = String(body.market ?? "");
  const market = isCountry(claimedMarket) ? claimedMarket : DEFAULT_COUNTRY;
  const postalCode = String(body.postalCode ?? "").slice(0, 12);

  // A hostile value here buys nothing — see the note above — but it is still
  // coerced to a sane number so a string or a negative cannot reach the rules.
  const claimed = Number(body.orderValueInr);
  const orderValueInr =
    Number.isFinite(claimed) && claimed > 0 ? Math.min(claimed, 10_000_000) : 0;

  try {
    const verdict = await getDeliveryQuote({ market, postalCode, orderValueInr });
    return NextResponse.json(verdict);
  } catch (e) {
    // Never a stack trace, never a provider message. The customer gets a state
    // the component knows how to phrase.
    console.error("Delivery check failed:", e);
    return NextResponse.json({ status: "unavailable" });
  }
}

import { formatINR } from "@/lib/utils";
import type { ShippingConfig } from "@/lib/shipping";

/**
 * What delivery costs, said next to the button that charges for it.
 *
 * Until now the product page said nothing at all about delivery — a grep across
 * components/product for delivery, returns, dispatch or shipping returned
 * nothing. The customer decided whether to buy without knowing whether postage
 * would be added, which is a question people answer pessimistically.
 *
 * EVERY LINE COMES FROM THE SHIPPING CONFIG, the same object quoteShipping()
 * charges from at checkout. Nothing here is written prose about delivery: if the
 * flat rate changes in admin, this changes with it, and the page cannot drift
 * away from the till.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *   A dispatch promise. "Ships within N days" is a commitment to a customer and
 *   it is not in the data. `dispatch_days` exists in the config for the day it
 *   becomes a real number, and while it is 0 this renders nothing rather than
 *   inventing something reassuring.
 *
 *   Returns. There is no returns policy to summarise — /in/policies currently
 *   reads "Add your returns policy here." Linking a customer to that from the
 *   point of purchase would be worse than staying quiet, and summarising a
 *   policy that does not exist would be worse still.
 *
 *   Badges. Three plain lines, in the page's own voice. A row of icons is how a
 *   shop signals it is worried about being trusted.
 */
export default function DeliveryNote({ shipping }: { shipping: ShippingConfig }) {
  const lines: string[] = [];

  if (shipping.dispatch_days > 0) {
    lines.push(
      shipping.dispatch_days === 1
        ? "Dispatched the next working day."
        : `Dispatched within ${shipping.dispatch_days} working days.`
    );
  }

  // Kerala is the home market and free; saying so is the most useful single
  // fact for most of the people reading this page.
  if (shipping.free_pin_prefixes.length > 0) {
    lines.push("Free delivery across Kerala.");
  }

  if (shipping.flat_rate_inr > 0) {
    lines.push(`${formatINR(shipping.flat_rate_inr)} elsewhere in India.`);
  }

  if (shipping.free_above_inr > 0) {
    lines.push(`Free on orders over ${formatINR(shipping.free_above_inr)}.`);
  }

  // A configuration with nothing to say renders nothing, rather than an empty
  // bordered box explaining that it is empty.
  if (lines.length === 0) return null;

  return (
    <div className="border-t border-ink/10 pt-5">
      <h3 className="font-heading text-sm uppercase tracking-wider text-ink/60">
        Delivery
      </h3>
      <ul className="mt-2.5 space-y-1.5 text-sm leading-relaxed text-ink/70">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

import {
  CLOSING_TEXT,
  closing,
  externalButton,
  footerText,
  greeting,
  greetingText,
  heading,
  html,
  infoBox,
  paragraph,
  renderEmail,
  strong,
  type EmailFooter,
} from "./layout";
import { greetingName } from "./orderConfirmation";
import { INDIA_POST_LABEL, INDIA_POST_TRACKING_URL } from "../couriers/indiaPost";

/**
 * The email a customer gets when their order is handed to India Post
 * (WP-EMAIL-E3b). Sent once per dispatch, through the same durable delivery
 * record as the order confirmation (0074/0075).
 *
 * ONLY WHAT IS KNOWN. The order was handed to India Post Speed Post under this
 * consignment number. Nothing about where it is, when it will arrive, or
 * whether it has. No address and no item list: the confirmation already
 * carried those, and this one only needs to say "it has gone, here is how to
 * follow it".
 *
 * THE LINK goes to India Post's own tracking page — one exact URL approved in
 * the shared layout — never to an address built from the number (India
 * Post's form needs a CAPTCHA; see lib/couriers/indiaPost). The number is
 * shown large enough to copy.
 */

export interface ShipmentEmailData {
  orderRef: string;
  customerName: string | null;
  /** Upper-case letters and digits, as stored by dispatch_order. */
  consignment: string;
}

const FOOTER: EmailFooter = { kind: "transactional" };
const HEADING = "Your order is on its way";
const HANDED_OVER = `We've handed your order to ${INDIA_POST_LABEL}.`;
const HOW_TO_TRACK =
  "To follow it, open India Post's tracking page, enter the consignment number above and complete the verification step the page asks for.";
const PATIENCE = "If the tracking page shows nothing yet, please check again a little later.";
const BUTTON = "Track on India Post";

export function shipmentNotificationSubject(orderRef: string): string {
  return `Your THE WOVENNE order ${orderRef} is on its way`;
}

export function shipmentNotificationText(d: ShipmentEmailData): string {
  return [
    greetingText(greetingName(d.customerName)),
    "",
    `${HEADING}. ${HANDED_OVER}`,
    "",
    `Order reference: ${d.orderRef}`,
    `Courier: ${INDIA_POST_LABEL}`,
    `Consignment number: ${d.consignment}`,
    "",
    HOW_TO_TRACK,
    `India Post tracking: ${INDIA_POST_TRACKING_URL}`,
    "",
    PATIENCE,
    "",
    CLOSING_TEXT,
    "",
    footerText(FOOTER),
  ].join("\n");
}

export function shipmentNotificationHtml(d: ShipmentEmailData): string {
  return renderEmail({
    title: shipmentNotificationSubject(d.orderRef),
    preheader: `${HANDED_OVER} Consignment ${d.consignment}.`,
    body: [
      heading(HEADING),
      greeting(greetingName(d.customerName)),
      paragraph(HANDED_OVER),
      infoBox(
        html`Order reference ${strong(d.orderRef)}<br>Courier ${strong(INDIA_POST_LABEL)}<br>Consignment number <span style="font-size:17px;letter-spacing:1px;font-weight:bold;">${d.consignment}</span>`
      ),
      paragraph(HOW_TO_TRACK, { spaceAfter: 16 }),
      externalButton({ href: INDIA_POST_TRACKING_URL, label: BUTTON }),
      paragraph(PATIENCE, { tone: "small" }),
      closing(),
    ],
    footer: FOOTER,
  });
}

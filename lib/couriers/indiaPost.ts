import { INDIA_POST_TRACKING_URL } from "../emails/layout";

/**
 * India Post Speed Post — the only courier supported for now (WP-EMAIL-E3).
 *
 * WHAT IS KNOWN ABOUT THE NUMBER, AND FROM WHERE.
 *   UPU standard S10 (the international format India Post uses for tracked
 *   mail): 13 characters — a two-letter service indicator, an eight-digit
 *   serial, one check digit, and the two-letter country code of the issuing
 *   post (IN). Service indicators EA–EZ are EMS, which is what Speed Post is.
 *   The check digit: the eight serial digits weighted 8 6 4 2 3 5 9 7, summed;
 *   C = 11 − (sum mod 11); 10 → 0, 11 → 5.
 *
 * WHAT IS NOT KNOWN: that every number India Post issues to a business
 * account follows it. So nothing here REFUSES a number for not matching the
 * pattern. A number is refused only when it cannot be a reference at all
 * (empty, over 30 characters, or anything other than letters and digits after
 * spaces and hyphens are removed). Everything else is classified, and anything
 * but a check-digit-valid Speed Post number needs the admin to confirm it.
 *
 * THE TRACKING LINK. India Post's tracking is a form on its home page that
 * needs a CAPTCHA (checked 1 Nov 2026: https://www.indiapost.gov.in/ carries
 * "Consignment / Money Order Number" with a CAPTCHA, and India Post's own
 * /track-and-trace redirects there; the old
 * /_layouts/15/dop.portal.tracking/trackconsignment.aspx returns 502). There
 * is no verified address that takes the number, so the email links to the
 * page and shows the number to enter — it never builds a URL from it.
 */

export const INDIA_POST_COURIER_CODE = "india_post_speed_post";
export const INDIA_POST_LABEL = "India Post — Speed Post";
export { INDIA_POST_TRACKING_URL };

export const CONSIGNMENT_MAX_LENGTH = 30;

export type ConsignmentKind =
  /** S10, EA–EZ, IN, check digit valid: a Speed Post number. */
  | "speed_post"
  /** S10 and check digit valid, but not an EMS indicator or not IN. */
  | "s10_other_service"
  /** S10-shaped but the check digit is wrong: probably a typing mistake. */
  | "check_digit_mismatch"
  /** Letters and digits, but not the S10 shape. */
  | "unrecognised";

export type ConsignmentCheck =
  | { ok: false; reason: "empty" | "too_long" | "invalid_characters" }
  | {
      ok: true;
      /** Upper-case, letters and digits only — what is stored and shown. */
      value: string;
      kind: ConsignmentKind;
      /** True unless kind is speed_post: the admin must confirm it. */
      needsConfirmation: boolean;
      /** For the admin, never the customer. */
      note: string | null;
    };

const S10 = /^([A-Z]{2})(\d{8})(\d)([A-Z]{2})$/;
const WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7];

/** The S10 check digit for an eight-digit serial. */
export function s10CheckDigit(serial: string): number {
  const sum = serial.split("").reduce((s, d, i) => s + Number(d) * WEIGHTS[i], 0);
  const c = 11 - (sum % 11);
  return c === 10 ? 0 : c === 11 ? 5 : c;
}

export function checkConsignment(input: unknown): ConsignmentCheck {
  const value = String(input ?? "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
  if (!value) return { ok: false, reason: "empty" };
  if (value.length > CONSIGNMENT_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!/^[A-Z0-9]+$/.test(value)) return { ok: false, reason: "invalid_characters" };

  const m = S10.exec(value);
  if (!m) {
    return {
      ok: true,
      value,
      kind: "unrecognised",
      needsConfirmation: true,
      note: "This is not in the usual Speed Post format (two letters, nine digits, IN). Check it against the booking receipt.",
    };
  }
  const [, service, serial, check, country] = m;
  if (s10CheckDigit(serial) !== Number(check)) {
    return {
      ok: true,
      value,
      kind: "check_digit_mismatch",
      needsConfirmation: true,
      note: "The check digit does not match — this is often a mistyped digit. Check it against the booking receipt.",
    };
  }
  if (!service.startsWith("E") || country !== "IN") {
    return {
      ok: true,
      value,
      kind: "s10_other_service",
      needsConfirmation: true,
      note: `This looks like a ${country === "IN" ? "non-Speed Post India Post" : "non-Indian"} number (${service}…${country}). Check it is the Speed Post consignment.`,
    };
  }
  return { ok: true, value, kind: "speed_post", needsConfirmation: false, note: null };
}

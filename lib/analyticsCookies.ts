/**
 * The two small cookies analytics reads, shared by the browser client, the
 * collector, middleware and the cookie information page. In their own module
 * so the browser bundle does not pull in the collector's server code.
 *
 *   wv_stats_off  "1" when the visitor has turned off Wovenne's usage
 *                 statistics on this device (/in/cookies). Holds nothing but
 *                 that choice; it is not an identifier and is never sent
 *                 anywhere but back to this site. 1 year.
 *   wv_internal   "1" on any browser that has completed an admin sign-in, so
 *                 staff browsing the shop is labelled internal and left out of
 *                 reports. Not cleared on sign-out: the device stays a staff
 *                 device. Grants nothing. 1 year.
 *
 * Wovenne's analytics sets NO identifier — no visitor id, no session id.
 */
export const OPT_OUT_COOKIE = "wv_stats_off";
export const INTERNAL_COOKIE = "wv_internal";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

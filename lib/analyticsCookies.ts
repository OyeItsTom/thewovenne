/**
 * The analytics cookies' names, shared by the browser client, the collector
 * and middleware. In its own module so the browser bundle does not pull in the
 * collector's server code.
 *
 *   wv_consent   the visitor's choice; "analytics" in it permits a visitor id.
 *                Written by the consent prompt (not built yet).
 *   wv_vid       random visitor id — created only with analytics consent.
 *   wv_internal  "1" on any browser that has completed an admin sign-in, so
 *                staff browsing the shop is tagged internal. Not cleared on
 *                sign-out: the device stays a staff device.
 */
export const CONSENT_COOKIE = "wv_consent";
export const VISITOR_COOKIE = "wv_vid";
export const INTERNAL_COOKIE = "wv_internal";

/**
 * The browser half of Wovenne's first-party usage statistics. Deliberately
 * tiny: no SDK, no Supabase, no dependencies — a queue and a beacon. Design:
 * docs/analytics.md.
 *
 * WHEN IT SENDS NOTHING AT ALL
 *   * NEXT_PUBLIC_ANALYTICS_ENABLED is not "1" (the default);
 *   * the page is not on the production host (localhost, *.vercel.app);
 *   * the browser is automated (navigator.webdriver — Lighthouse, Playwright);
 *   * the visitor has turned statistics off (wv_stats_off), or the browser
 *     sends Global Privacy Control.
 *   On the server, nothing is written outside production or while the
 *   database switch is off.
 *
 * WHAT IT STORES ON THE DEVICE
 *   Nothing. No visitor id, no session id. The only cookie it reads is the
 *   visitor's own opt-out choice, written by the control on /in/cookies.
 *
 * WHAT IT REMEMBERS, IN MEMORY, UNTIL THE PAGE IS RELOADED
 *   How this page load arrived — the referrer's host, any utm_ tags, and the
 *   NAME of an ad-click parameter (gclid…) if present, never its value — so
 *   every event in the visit can be reported by channel without identifying
 *   anyone. A reload or a new tab starts again.
 *
 * HOW IT SENDS
 *   Events queue in memory and leave in one request: after 5 seconds, at 10
 *   events, or when the page is hidden — via sendBeacon, which never delays
 *   navigation or competes with the page for the main thread.
 */
import { COOKIE_MAX_AGE, OPT_OUT_COOKIE } from "./analyticsCookies";

const ENABLED = process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === "1";

/** Must match lib/seo PRODUCTION_ORIGIN (a test checks it). */
export const PRODUCTION_HOST = "www.thewovenne.com";

const ENDPOINT = "/api/events";
const FLUSH_AFTER_MS = 5000;
const FLUSH_AT = 10;
const CLICK_IDS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid"];

type EventType =
  | "page_view"
  | "product_view"
  | "search"
  | "wishlist_add"
  | "wishlist_remove"
  | "cart_add"
  | "cart_remove"
  | "checkout_start"
  | "whatsapp_click";

interface Fields {
  is_entry?: boolean;
  product_id?: string;
  search_term?: string;
  result_count?: number;
  quantity?: number;
}

interface Attribution {
  referrer_host?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  click_id?: string;
}

let queue: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
let attribution: Attribution | null = null;
let lastPath: string | null = null;
/** Increments once per page view; "once per page" guards key on it. */
let pageSeq = 0;
const onceKeys = new Set<string>();

function readCookie(name: string): string | undefined {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

/**
 * Whether this build of the site sends usage statistics at all. Public: the
 * cookie page uses it to say plainly when nothing is being collected, so a
 * visitor's preference is never mistaken for collection actually running.
 */
export function siteCollectsStatistics(): boolean {
  return ENABLED;
}

/** Whether this visitor has turned statistics off (explicitly, or via GPC). */
export function statisticsOff(): boolean {
  if (typeof document === "undefined") return false;
  const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  return gpc || readCookie(OPT_OUT_COOKIE) === "1";
}

/**
 * The visitor's choice, from the control on /in/cookies. Turning statistics
 * off also drops anything still queued on this page.
 */
export function setStatisticsOff(off: boolean): void {
  if (off) {
    document.cookie = `${OPT_OUT_COOKIE}=1; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax; Secure`;
    queue = [];
  } else {
    document.cookie = `${OPT_OUT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
  }
}

function active(): boolean {
  if (!ENABLED || typeof window === "undefined") return false;
  if (window.location.hostname !== PRODUCTION_HOST) return false;
  if (navigator.webdriver) return false;
  return !statisticsOff();
}

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** How this page load arrived. Read once; never stored. */
function pageLoadAttribution(): Attribution {
  if (attribution) return attribution;
  const params = new URLSearchParams(window.location.search);
  const tag = (k: string) => params.get(k)?.slice(0, 100) || undefined;
  let referrerHost: string | undefined;
  try {
    referrerHost = document.referrer ? new URL(document.referrer).hostname || undefined : undefined;
  } catch {
    // An unparseable referrer is no referrer.
  }
  attribution = {
    referrer_host: referrerHost,
    utm_source: tag("utm_source"),
    utm_medium: tag("utm_medium"),
    utm_campaign: tag("utm_campaign"),
    utm_content: tag("utm_content"),
    utm_term: tag("utm_term"),
    click_id: CLICK_IDS.find((k) => params.has(k)),
  };
  return attribution;
}

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (statisticsOff()) {
    queue = [];
    return;
  }
  while (queue.length) {
    const body = JSON.stringify({ events: queue.splice(0, 20) });
    const sent =
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    if (!sent) {
      void fetch(ENDPOINT, {
        method: "POST",
        body,
        keepalive: true,
        headers: { "content-type": "application/json" },
      }).catch(() => {});
    }
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enqueue(type: EventType, input: Fields = {}): void {
  if (!active()) return;
  const fields = { ...input };
  // The server rejects a whole batch over one bad event, so never send one.
  if (fields.product_id !== undefined && !UUID.test(fields.product_id)) return;
  if (fields.quantity !== undefined) fields.quantity = Math.min(99, Math.max(1, Math.round(fields.quantity)));
  if (fields.search_term !== undefined) fields.search_term = fields.search_term.slice(0, 200);
  listen();
  queue.push({
    type,
    client_event_id: uuid(),
    path: window.location.pathname,
    ...pageLoadAttribution(),
    ...fields,
  });
  if (queue.length >= FLUSH_AT) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_AFTER_MS);
}

/** One page view per distinct pathname; the first of a page load is the entry. */
export function trackPageView(): void {
  if (!active()) return;
  const path = window.location.pathname;
  if (path === lastPath) return;
  const entry = lastPath === null;
  lastPath = path;
  pageSeq += 1;
  enqueue("page_view", entry ? { is_entry: true } : {});
}

/** At most once per page view for a given key — React may run effects twice. */
export function trackOncePerPage(key: string, type: EventType, fields: Fields = {}): void {
  if (!active()) return;
  const k = `${pageSeq}|${key}`;
  if (onceKeys.has(k)) return;
  onceKeys.add(k);
  enqueue(type, fields);
}

/** A user action: every call is one event (adding to the bag twice is two adds). */
export function track(type: EventType, fields: Fields = {}): void {
  enqueue(type, fields);
}

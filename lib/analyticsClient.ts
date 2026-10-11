/**
 * The browser half of Wovenne's first-party analytics. Deliberately tiny: no
 * SDK, no Supabase, no dependencies — a queue and a beacon.
 *
 * WHEN IT SENDS NOTHING AT ALL
 *   * NEXT_PUBLIC_ANALYTICS_ENABLED is not "1" (the default);
 *   * the page is not on the production host (localhost, *.vercel.app);
 *   * the browser is automated (navigator.webdriver);
 *   * on the server, if it is not the production deployment.
 *
 * WHAT IT STORES ON THE DEVICE
 *   Nothing, unless the visitor has given analytics consent (the `wv_consent`
 *   cookie lists "analytics"). Then one random id, `wv_vid`, so visits can be
 *   counted as visitors and sessions. Withdrawn consent deletes it.
 *   No consent prompt exists yet; until one is approved and shipped, no
 *   visitor id is ever created.
 *
 * HOW IT SENDS
 *   Events queue in memory and leave in one request: after 5 seconds, at 10
 *   events, or when the page is hidden — via sendBeacon, which never delays
 *   navigation or competes with the page for the main thread.
 */
import { CONSENT_COOKIE, VISITOR_COOKIE } from "./analyticsCookies";

const ENABLED = process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === "1";

/** Must match lib/seo PRODUCTION_ORIGIN (a test checks it). */
export const PRODUCTION_HOST = "www.thewovenne.com";

const ENDPOINT = "/api/events";
const FLUSH_AFTER_MS = 5000;
const FLUSH_AT = 10;
const VISITOR_MAX_AGE = 60 * 60 * 24 * 180;

type EventType =
  | "page_view"
  | "product_view"
  | "search"
  | "cart_add"
  | "cart_remove"
  | "checkout_start"
  | "whatsapp_click";

interface Fields {
  is_entry?: boolean;
  referrer_host?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  product_id?: string;
  search_term?: string;
  result_count?: number;
  quantity?: number;
}

let queue: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
let entrySent = false;
let lastPath: string | null = null;
/** Increments once per page view; "once per page" guards key on it. */
let pageSeq = 0;
const onceKeys = new Set<string>();

function active(): boolean {
  if (!ENABLED || typeof window === "undefined") return false;
  if (window.location.hostname !== PRODUCTION_HOST) return false;
  if (navigator.webdriver) return false;
  return true;
}

function readCookie(name: string): string | undefined {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The consented visitor id: created with consent, removed without it. Called
 * before every send so a choice made mid-visit takes effect at once.
 */
function syncVisitorCookie(): void {
  const consent = decodeURIComponent(readCookie(CONSENT_COOKIE) ?? "");
  const consented = consent.split(/[,|]/).map((s) => s.trim()).includes("analytics");
  const existing = readCookie(VISITOR_COOKIE);
  if (consented && !existing) {
    document.cookie = `${VISITOR_COOKIE}=${uuid()}; Max-Age=${VISITOR_MAX_AGE}; Path=/; SameSite=Lax; Secure`;
  } else if (!consented && existing) {
    document.cookie = `${VISITOR_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
  }
}

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  while (queue.length) {
    const body = JSON.stringify({ events: queue.splice(0, 20) });
    syncVisitorCookie();
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
  const fields = { ...input };
  if (!active()) return;
  // The server rejects a whole batch over one bad event, so never send one.
  if (fields.product_id !== undefined && !UUID.test(fields.product_id)) return;
  if (fields.quantity !== undefined) fields.quantity = Math.min(99, Math.max(1, Math.round(fields.quantity)));
  if (fields.search_term !== undefined) fields.search_term = fields.search_term.slice(0, 200);
  listen();
  queue.push({ type, client_event_id: uuid(), path: window.location.pathname, ...fields });
  if (queue.length >= FLUSH_AT) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_AFTER_MS);
}

/**
 * One page view per distinct pathname. The first of a page load is the entry
 * page and carries attribution: the referrer's HOST (only if it is another
 * site) and any utm_ parameters on the landing URL.
 */
export function trackPageView(): void {
  if (!active()) return;
  const path = window.location.pathname;
  if (path === lastPath) return;
  lastPath = path;
  pageSeq += 1;

  if (entrySent) {
    enqueue("page_view");
    return;
  }
  entrySent = true;
  const params = new URLSearchParams(window.location.search);
  let referrerHost: string | undefined;
  try {
    const ref = document.referrer ? new URL(document.referrer).hostname : "";
    if (ref && ref !== window.location.hostname) referrerHost = ref;
  } catch {
    // An unparseable referrer is no referrer.
  }
  const utm = (k: string) => params.get(k)?.slice(0, 100) || undefined;
  enqueue("page_view", {
    is_entry: true,
    referrer_host: referrerHost,
    utm_source: utm("utm_source"),
    utm_medium: utm("utm_medium"),
    utm_campaign: utm("utm_campaign"),
  });
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

/** Test seam: what is waiting to be sent. */
export function _pending(): readonly Record<string, unknown>[] {
  return queue;
}

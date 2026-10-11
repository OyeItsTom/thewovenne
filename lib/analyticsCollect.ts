import crypto from "node:crypto";

/**
 * What the event collector (/api/events) accepts, and how it is cut down before
 * it reaches the database.
 *
 * Pure functions, so the rules are tested directly rather than through HTTP.
 * The database re-checks the parts that matter (migration 0068); this is the
 * first gate, and the one that keeps junk off the network round-trip.
 *
 * THE BODY IS A CLOSED SHAPE. Any key not listed here — `user_id`, `traffic`,
 * `occurred_at`, a nested object — rejects the whole batch. A browser cannot
 * claim to be somebody, claim a purchase, or claim to be staff; identity and
 * traffic class are worked out on the server from the request itself.
 */

/** Events a browser may report. Wishlist and purchase come from the database. */
export const CLIENT_EVENT_TYPES = [
  "page_view",
  "product_view",
  "search",
  "cart_add",
  "cart_remove",
  "checkout_start",
  "whatsapp_click",
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_BATCH = 20;

const EVENT_KEYS = new Set([
  "type",
  "client_event_id",
  "path",
  "is_entry",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "product_id",
  "search_term",
  "result_count",
  "quantity",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One event, as it is handed to analytics_ingest(). */
export interface CleanEvent {
  type: ClientEventType;
  client_event_id: string | null;
  path: string | null;
  is_entry: boolean;
  source: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  product_id: string | null;
  search_term: string | null;
  result_count: number | null;
  quantity: number | null;
}

export type ParseResult =
  | { ok: true; events: CleanEvent[] }
  | { ok: false; reason: string };

/**
 * A path, never a URL: no origin, no query string, no fragment. Query strings
 * are where emails, tokens and search terms live; none of them belong here.
 */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return null;
  const path = raw.split(/[?#]/)[0].replace(/\/{2,}/g, "/");
  if (!/^[\x21-\x7e]*$/.test(path)) return null;
  return path.slice(0, 200);
}

/** A hostname only — `l.instagram.com`, never the URL it came with. */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.trim().toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9.-]{1,100}$/.test(host) || !host.includes(".")) return null;
  return host;
}

/** UTM values are campaign labels: lower-cased, bounded, plain characters. */
export function normalizeUtm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_.\-+]/g, "");
  return v ? v.slice(0, 60) : null;
}

/**
 * What a search box should never keep: an email address, a phone number, a
 * long run of digits (an order or card number). The search still counts; the
 * words do not.
 */
export const REDACTED_TERM = "(redacted)";

export function normalizeSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const term = raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!term) return null;
  const digits = (term.match(/\d/g) ?? []).length;
  if (term.includes("@") || digits >= 7 || /\d{5,}/.test(term)) return REDACTED_TERM;
  return term.slice(0, 64);
}

/**
 * The channel a visit arrived from, read only from what was actually captured.
 * A UTM source wins (it was put there on purpose); then the referrer's host.
 * Nothing at all is "direct" — which in practice also includes apps and
 * browsers that strip the referrer, and is labelled that way in reports.
 * An unrecognised host is kept as `other`, never guessed into a channel.
 */
const CHANNELS: Array<[RegExp, string]> = [
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
  [/(^|\.)yahoo\.com$/, "yahoo"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "whatsapp"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "x"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com)$/, "ai_assistant"],
];

export function sourceFor(referrerHost: string | null, utmSource: string | null): string {
  if (utmSource) {
    const s = utmSource.replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
    if (s) return s;
  }
  if (!referrerHost) return "direct";
  for (const [re, name] of CHANNELS) if (re.test(referrerHost)) return name;
  return "other";
}

function optionalUuid(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : undefined;
}

function optionalInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === undefined || v === null) return null;
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : undefined;
}

/**
 * Validate a whole batch. One bad event rejects the lot: a well-behaved client
 * never sends one, so a bad one means a broken or hostile sender, and partial
 * acceptance would only make that harder to notice.
 */
export function parseBatch(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "body" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "events") return { ok: false, reason: "body keys" };
  const list = (body as { events: unknown }).events;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: "events" };
  if (list.length > MAX_BATCH) return { ok: false, reason: "batch size" };

  const events: CleanEvent[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "event" };
    const e = raw as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!EVENT_KEYS.has(k)) return { ok: false, reason: `key ${k}` };
    for (const v of Object.values(e)) {
      if (v !== null && typeof v === "object") return { ok: false, reason: "nested value" };
    }

    const type = e.type;
    if (typeof type !== "string" || !(CLIENT_EVENT_TYPES as readonly string[]).includes(type)) {
      return { ok: false, reason: "type" };
    }
    const clientEventId = optionalUuid(e.client_event_id);
    const productId = optionalUuid(e.product_id);
    const resultCount = optionalInt(e.result_count, 0, 10000);
    const quantity = optionalInt(e.quantity, 1, 99);
    if (clientEventId === undefined || productId === undefined) return { ok: false, reason: "uuid" };
    if (resultCount === undefined || quantity === undefined) return { ok: false, reason: "number" };
    if (e.is_entry !== undefined && typeof e.is_entry !== "boolean") return { ok: false, reason: "is_entry" };

    const path = normalizePath(e.path);
    if (path === null) return { ok: false, reason: "path" };

    const needsProduct = type === "product_view" || type === "cart_add" || type === "cart_remove";
    if (needsProduct && !productId) return { ok: false, reason: "product_id" };
    if ((type === "cart_add" || type === "cart_remove") && !quantity) return { ok: false, reason: "quantity" };

    const searchTerm = type === "search" ? normalizeSearchTerm(e.search_term) : null;
    if (type === "search" && !searchTerm) return { ok: false, reason: "search_term" };

    // Attribution is read on the entry page view only; elsewhere it is noise
    // (the referrer of an in-site navigation is the shop itself).
    const isEntry = type === "page_view" && e.is_entry === true;
    const referrerHost = isEntry ? normalizeHost(e.referrer_host) : null;
    const utmSource = isEntry ? normalizeUtm(e.utm_source) : null;

    events.push({
      type: type as ClientEventType,
      client_event_id: clientEventId,
      path,
      is_entry: isEntry,
      source: isEntry ? sourceFor(referrerHost, utmSource) : null,
      referrer_host: referrerHost,
      utm_source: utmSource,
      utm_medium: isEntry ? normalizeUtm(e.utm_medium) : null,
      utm_campaign: isEntry ? normalizeUtm(e.utm_campaign) : null,
      product_id: productId,
      search_term: searchTerm,
      result_count: type === "search" ? resultCount : null,
      quantity: type === "cart_add" || type === "cart_remove" ? quantity : null,
    });
  }
  return { ok: true, events };
}

/**
 * Automated traffic we can recognise from the request alone. Lighthouse,
 * PageSpeed, headless browsers, uptime checks, crawlers and link previewers.
 * Dropped, not stored: they are not demand.
 */
const BOT =
  /bot|crawl|spider|slurp|lighthouse|pagespeed|headlesschrome|phantomjs|puppeteer|playwright|selenium|gtmetrix|pingdom|uptime|monitor|vercel|preview|facebookexternalhit|whatsapp|curl|wget|python|node-fetch|axios|go-http|java\//i;

export function isBot(userAgent: string | null): boolean {
  if (!userAgent || userAgent.length < 20) return true;
  return BOT.test(userAgent);
}

/** Coarse class only. The User-Agent itself is never stored. */
export function deviceFor(userAgent: string | null): "mobile" | "tablet" | "desktop" | null {
  if (!userAgent) return null;
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(userAgent)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(userAgent)) return "mobile";
  return "desktop";
}

/**
 * Vercel's IP lookup: ISO country and first-level region (IN / KL). The city
 * header exists and is deliberately not read — IP-derived city is not
 * accurate enough to report. Anything malformed becomes null, not a guess.
 */
export function geoFor(headers: Headers): { country_code: string | null; region: string | null } {
  const country = headers.get("x-vercel-ip-country")?.trim().toUpperCase() ?? "";
  const region = headers.get("x-vercel-ip-country-region")?.trim().toUpperCase() ?? "";
  const validCountry = /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null;
  return {
    country_code: validCountry,
    region: validCountry && /^[A-Z0-9]{1,3}$/.test(region) ? region : null,
  };
}

/** The caller's address, first X-Forwarded-For hop (Vercel's own) — see lib/chatQuota. */
export function callerIp(headers: Headers): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * The rate limiter's key: an HMAC of the address and the UTC date, under a
 * server-only secret. It changes every day, so it cannot link one day's
 * visitor to the next, and without the secret it cannot be reversed by
 * hashing every IPv4 address. Lives in analytics_rate for ten minutes.
 */
export function rateKey(ip: string, secret: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return crypto.createHmac("sha256", `analytics-rate:${secret}`).update(`${day}|${ip}`).digest("hex");
}

/**
 * Whether this deployment writes analytics at all. Two locks:
 *   NEXT_PUBLIC_ANALYTICS_ENABLED=1  — the switch, off until approved;
 *   VERCEL_ENV=production            — previews and local never write,
 *                                      unless ANALYTICS_ALLOW_NONPROD=1 is set
 *                                      deliberately for a test.
 */
export function collectionEnabled(env: Record<string, string | undefined>): boolean {
  if (env.NEXT_PUBLIC_ANALYTICS_ENABLED !== "1") return false;
  return env.VERCEL_ENV === "production" || env.ANALYTICS_ALLOW_NONPROD === "1";
}

export { CONSENT_COOKIE, VISITOR_COOKIE, INTERNAL_COOKIE } from "./analyticsCookies";

/** Analytics consent is an explicit `analytics` entry in the consent cookie. */
export function hasAnalyticsConsent(consentCookie: string | undefined): boolean {
  if (!consentCookie) return false;
  return decodeURIComponent(consentCookie).split(/[,|]/).map((s) => s.trim()).includes("analytics");
}

/** The visitor id is honoured only with consent, and only if it is a UUID. */
export function visitorIdFor(consentCookie: string | undefined, visitorCookie: string | undefined): string | null {
  if (!hasAnalyticsConsent(consentCookie)) return null;
  return visitorCookie && UUID.test(visitorCookie) ? visitorCookie.toLowerCase() : null;
}

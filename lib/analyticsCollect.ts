import crypto from "node:crypto";

/**
 * What the event collector (/api/events) accepts, and how it is cut down before
 * it reaches the database. See docs/analytics.md for the whole design.
 *
 * Pure functions, so the rules are tested directly rather than through HTTP.
 * The database re-checks the parts that matter (migration 0068); this is the
 * first gate, and the one that keeps junk off the network round-trip.
 *
 * THE BODY IS A CLOSED SHAPE. Any key not listed here — `user_id`, `traffic`,
 * `source`, `occurred_at`, a nested object — rejects the whole batch. A browser
 * cannot claim to be somebody, claim a purchase, claim to be staff, or assert a
 * channel: identity does not exist in this design, and traffic class and
 * channel are worked out on the server from what was observed.
 */

/** Events a browser may report. Purchase comes from settlement, never here. */
export const CLIENT_EVENT_TYPES = [
  "page_view",
  "product_view",
  "search",
  "wishlist_add",
  "wishlist_remove",
  "cart_add",
  "cart_remove",
  "checkout_start",
  "whatsapp_click",
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_BATCH = 20;

/** Ad-click parameters, reported by NAME only — the value is never sent. */
export const CLICK_IDS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid"] as const;
type ClickId = (typeof CLICK_IDS)[number];

const EVENT_KEYS = new Set([
  "type",
  "client_event_id",
  "path",
  "is_entry",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "click_id",
  "product_id",
  "search_term",
  "result_count",
  "quantity",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_EVENTS = new Set(["product_view", "wishlist_add", "wishlist_remove", "cart_add", "cart_remove"]);

/** The shop's own hosts: a referrer from here says nothing about the channel. */
const OWN_HOSTS = new Set(["thewovenne.com", "www.thewovenne.com"]);

/** One event, as it is handed to analytics_ingest(). */
export interface CleanEvent {
  type: ClientEventType;
  client_event_id: string | null;
  path: string | null;
  is_entry: boolean;
  source: string | null;
  medium: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
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
  const host = raw.trim().toLowerCase();
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
 * long run of digits (an order, card or reference number). The search still
 * counts; the words do not.
 */
export const REDACTED_TERM = "(redacted)";

export function normalizeSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const term = raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!term) return null;
  const digits = (term.match(/\d/g) ?? []).length;
  if (term.includes("@") || digits >= 7 || /\d{5,}/.test(term) || /\bwv-?\d/.test(term)) return REDACTED_TERM;
  return term.slice(0, 64);
}

/**
 * Channel = source / medium, from what was OBSERVED, in this order:
 *
 *   1. utm_source present         → that source; utm_medium as given (or none)
 *   2. a Google / Microsoft ad click id → google / cpc, bing / cpc
 *   3. referrer is the shop itself → unknown (null / null) — e.g. a full
 *      reload inside the site; never guessed into "direct"
 *   4. a recognised referrer host  → e.g. google / organic, instagram / social,
 *      chatgpt / referral, email / email (webmail)
 *   5. an unrecognised host        → other / referral (host kept)
 *   6. no referrer, no tags        → direct / none — which in practice also
 *      includes apps and browsers that strip the referrer; reports say so
 *
 * An AI assistant is named ONLY when its own host is the referrer. Nothing is
 * inferred from timing, landing page or anything else.
 */
const HOSTS: Array<[RegExp, string, string]> = [
  [/^(mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com)$/, "email", "email"],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/, "chatgpt", "referral"],
  [/(^|\.)perplexity\.ai$/, "perplexity", "referral"],
  [/(^|\.)claude\.ai$/, "claude", "referral"],
  [/^gemini\.google\.com$/, "gemini", "referral"],
  [/(^|\.)copilot\.microsoft\.com$/, "copilot", "referral"],
  [/(^|\.)google\.[a-z.]+$/, "google", "organic"],
  [/(^|\.)bing\.com$/, "bing", "organic"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo", "organic"],
  [/(^|\.)search\.yahoo\.com$/, "yahoo", "organic"],
  [/(^|\.)ecosia\.org$/, "ecosia", "organic"],
  [/(^|\.)instagram\.com$/, "instagram", "social"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook", "social"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "whatsapp", "social"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube", "social"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest", "social"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "x", "social"],
  [/(^|\.)linkedin\.com$/, "linkedin", "social"],
];

export function attributionFor(input: {
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  clickId: ClickId | null;
}): { source: string | null; medium: string | null } {
  const label = (v: string) => v.replace(/[^a-z0-9_.+-]/g, "").slice(0, 40) || null;
  if (input.utmSource) {
    return { source: label(input.utmSource), medium: input.utmMedium ? label(input.utmMedium) : null };
  }
  if (input.clickId === "gclid" || input.clickId === "gbraid" || input.clickId === "wbraid") {
    return { source: "google", medium: "cpc" };
  }
  if (input.clickId === "msclkid") return { source: "bing", medium: "cpc" };
  const host = input.referrerHost;
  if (host && OWN_HOSTS.has(host)) return { source: null, medium: null };
  if (host) {
    for (const [re, source, medium] of HOSTS) if (re.test(host)) return { source, medium };
    // fbclid with an unrecognised referrer: a Meta link, channel otherwise unknown.
    if (input.clickId === "fbclid") return { source: "meta", medium: "social" };
    return { source: "other", medium: "referral" };
  }
  if (input.clickId === "fbclid") return { source: "meta", medium: "social" };
  return { source: "direct", medium: "none" };
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
    if (e.click_id !== undefined && !(CLICK_IDS as readonly unknown[]).includes(e.click_id)) {
      return { ok: false, reason: "click_id" };
    }

    const path = normalizePath(e.path);
    if (path === null) return { ok: false, reason: "path" };

    if (PRODUCT_EVENTS.has(type) && !productId) return { ok: false, reason: "product_id" };
    if ((type === "cart_add" || type === "cart_remove") && !quantity) return { ok: false, reason: "quantity" };

    const searchTerm = type === "search" ? normalizeSearchTerm(e.search_term) : null;
    if (type === "search" && !searchTerm) return { ok: false, reason: "search_term" };

    // Every event carries the attribution of the page load it happened in, so
    // a cart add can be reported by channel without any visitor identifier.
    const referrerHost = normalizeHost(e.referrer_host);
    const utmSource = normalizeUtm(e.utm_source);
    const utmMedium = normalizeUtm(e.utm_medium);
    const { source, medium } = attributionFor({
      referrerHost,
      utmSource,
      utmMedium,
      clickId: (e.click_id as ClickId | undefined) ?? null,
    });

    events.push({
      type: type as ClientEventType,
      client_event_id: clientEventId,
      path,
      is_entry: type === "page_view" && e.is_entry === true,
      source,
      medium,
      referrer_host: referrerHost && !OWN_HOSTS.has(referrerHost) ? referrerHost : null,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: normalizeUtm(e.utm_campaign),
      utm_content: normalizeUtm(e.utm_content),
      utm_term: normalizeUtm(e.utm_term),
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
 * PageSpeed, headless browsers, uptime checks, crawlers (search and AI) and
 * link previewers. Dropped, not stored: they are not demand.
 */
const BOT =
  /bot|crawl|spider|slurp|lighthouse|pagespeed|headlesschrome|phantomjs|puppeteer|playwright|selenium|gtmetrix|pingdom|uptime|monitor|vercel|preview|facebookexternalhit|whatsapp|curl|wget|python|node-fetch|axios|go-http|java\/|chatgpt-user|perplexity|claude-web/i;

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
 * header exists and is deliberately not read. Approximate by nature — VPNs,
 * mobile carriers' gateways and iCloud Private Relay all move it. Anything
 * malformed becomes null, not a guess.
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
 * traffic to the next, and without the secret it cannot be reversed by
 * hashing every IPv4 address. Lives in analytics_rate for minutes and is
 * never written to analytics_events.
 */
export function rateKey(ip: string, secret: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return crypto.createHmac("sha256", `analytics-rate:${secret}`).update(`${day}|${ip}`).digest("hex");
}

/**
 * Which deployment this is, for analytics. Only the production deployment
 * writes real traffic. A preview or local build writes nothing — unless
 * ANALYTICS_ALLOW_NONPROD=1 is set on purpose for a test, and then everything
 * it writes is labelled `test`, never customer. Whether anything is written AT
 * ALL is still the database's switch (analytics_config) — this only decides
 * whether to ask.
 */
export type DeploymentMode = "production" | "test" | "off";

export function deploymentMode(env: Record<string, string | undefined>): DeploymentMode {
  if (env.VERCEL_ENV === "production") return "production";
  if (env.ANALYTICS_ALLOW_NONPROD === "1") return "test";
  return "off";
}

export { INTERNAL_COOKIE, OPT_OUT_COOKIE } from "./analyticsCookies";

/**
 * The visitor has objected: the opt-out cookie, or the browser's Global
 * Privacy Control signal. GPC is honoured IN ADDITION to the explicit control
 * on /in/cookies, never instead of it (ICO: browser settings alone are not
 * enough to rely on).
 */
export function optedOut(optOutCookie: string | undefined, gpcHeader: string | null): boolean {
  return optOutCookie === "1" || gpcHeader?.trim() === "1";
}

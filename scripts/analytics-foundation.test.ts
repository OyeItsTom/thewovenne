/**
 * Analytics foundation (1A): the switch, what the collector accepts, what the
 * browser sends, how purchases are recorded, and what the database stores
 * and lets each role do. Design: docs/analytics.md.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/analytics-foundation.test.ts
 *
 * Halves:
 *   rules     lib/analyticsCollect — the closed body shape and its cleaning;
 *   handler   lib/analyticsIngest — deployment, size, origin, opt-out, bots,
 *             staff and rate limit, with the database faked;
 *   purchase  lib/analyticsPurchase — deployment and payment mode;
 *   browser   lib/analyticsClient against a fake window/document/navigator;
 *   wiring    the source files that call all of this;
 *   database  migration 0068 on a throwaway Postgres (embedded-postgres),
 *             through the real roles and grants. Without it the run exits 2.
 *
 * Nothing here reads .env.local or touches production.
 */
import fs from "node:fs";
import {
  MAX_BODY_BYTES,
  REDACTED_TERM,
  attributionFor,
  deploymentMode,
  deviceFor,
  geoFor,
  isBot,
  normalizePath,
  normalizeSearchTerm,
  optedOut,
  parseBatch,
  rateKey,
  type CleanEvent,
} from "../lib/analyticsCollect";
import { handleEvents, type EventsDeps, type IngestContext } from "../lib/analyticsIngest";
import { recordPurchase } from "../lib/analyticsPurchase";
import { PRODUCTION_ORIGIN } from "../lib/seo";
import { asAdmin, asRoot, asService, asStaffPasswordOnly, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

const P = "6f1c2a52-8d1e-4c43-9b0a-3f6f0b6c1a11";
const UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const UA_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const UA_LIGHTHOUSE = "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse";
const UA_GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const UA_OAI = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot";

// ── Rules ────────────────────────────────────
console.log("\nrules: the body is a closed shape");
const ok = (events: unknown[]) => parseBatch({ events });
t("1. an anonymous page view is accepted", ok([{ type: "page_view", path: "/in/shop" }]).ok);
for (const k of ["user_id", "visitor_id", "session_id", "traffic", "source", "medium", "occurred_at", "email", "ip"]) {
  t(`3. a body claiming ${k} is refused`, !ok([{ type: "page_view", path: "/in", [k]: "x" }]).ok);
}
t("3. a top-level user_id is refused", !parseBatch({ events: [{ type: "page_view", path: "/in" }], user_id: P }).ok);
t("4/18. purchase from a browser is refused", !ok([{ type: "purchase", path: "/in" }]).ok);
t("4. an unknown type is refused", !ok([{ type: "scroll", path: "/in" }]).ok);
t("13/14. wishlist add/remove accepted with a product", ok([{ type: "wishlist_add", path: "/in/p", product_id: P }, { type: "wishlist_remove", path: "/in/p", product_id: P }]).ok);
t("13. wishlist without a product is refused", !ok([{ type: "wishlist_add", path: "/in/p" }]).ok);
t("6. nested metadata is refused", !ok([{ type: "page_view", path: "/in", utm_source: { a: 1 } }]).ok);
t("6. a non-UUID product is refused", !ok([{ type: "product_view", path: "/in", product_id: "1 or 1=1" }]).ok);
t("6. cart_add without quantity is refused", !ok([{ type: "cart_add", path: "/in", product_id: P }]).ok);
t("6. quantity 100 is refused", !ok([{ type: "cart_add", path: "/in", product_id: P, quantity: 100 }]).ok);
t("6. a full URL as path is refused", !ok([{ type: "page_view", path: "https://evil.example/x" }]).ok && !ok([{ type: "page_view", path: "//evil.example" }]).ok);
t("6. a click-id VALUE is refused (only the parameter name is allowed)", !ok([{ type: "page_view", path: "/in", click_id: "Cj0KCQjw" }]).ok);
t("6. 21 events is refused", !ok(Array.from({ length: 21 }, () => ({ type: "page_view", path: "/in" }))).ok);
t("6. an empty batch is refused", !ok([]).ok);
t("path drops the query string and fragment", normalizePath("/in/search?q=my@email.com#x") === "/in/search");
const ent = ok([{ type: "page_view", path: "/in", is_entry: true, referrer_host: "l.instagram.com", utm_campaign: "Onam Edit", utm_content: "Reel 2", utm_term: "Kasavu Saree" }]);
t("entry page view: source/medium from the referrer host, all five UTMs kept",
  ent.ok && ent.events[0].source === "instagram" && ent.events[0].medium === "social" && ent.events[0].utm_campaign === "onam_edit" &&
  ent.events[0].utm_content === "reel_2" && ent.events[0].utm_term === "kasavu_saree");
const cart = ok([{ type: "cart_add", path: "/in/p", product_id: P, quantity: 1, is_entry: true, referrer_host: "www.google.co.in" }]);
t("every event carries its page load's attribution (cart add by channel, no identifier)",
  cart.ok && cart.events[0].source === "google" && cart.events[0].medium === "organic" && !cart.events[0].is_entry);

console.log("\nrules: attribution is only what was observed");
const A = (o: Partial<Parameters<typeof attributionFor>[0]>) => attributionFor({ referrerHost: null, utmSource: null, utmMedium: null, clickId: null, ...o });
const eq = (x: { source: string | null; medium: string | null }, s: string | null, m: string | null) => x.source === s && x.medium === m;
t("35. nothing observed → direct / none", eq(A({}), "direct", "none"));
t("35. a reload from inside the shop → unknown, NOT direct", eq(A({ referrerHost: "www.thewovenne.com" }), null, null));
t("35. an unrecognised host → other / referral", eq(A({ referrerHost: "someblog.example" }), "other", "referral"));
t("google.co.in → google / organic", eq(A({ referrerHost: "www.google.co.in" }), "google", "organic"));
t("gclid → google / cpc", eq(A({ clickId: "gclid" }), "google", "cpc"));
t("utm wins: newsletter / email", eq(A({ utmSource: "newsletter", utmMedium: "email", referrerHost: "mail.google.com" }), "newsletter", "email"));
t("webmail without tags → email / email (not google)", eq(A({ referrerHost: "mail.google.com" }), "email", "email"));
t("chatgpt.com → chatgpt / referral", eq(A({ referrerHost: "chatgpt.com" }), "chatgpt", "referral"));
t("gemini.google.com → gemini, not google organic", eq(A({ referrerHost: "gemini.google.com" }), "gemini", "referral"));
t("claude.ai and perplexity.ai named only from their own host", eq(A({ referrerHost: "claude.ai" }), "claude", "referral") && eq(A({ referrerHost: "www.perplexity.ai" }), "perplexity", "referral"));
t("utm_source without utm_medium → medium unknown, not guessed", eq(A({ utmSource: "instagram" }), "instagram", null));
t("fbclid with no referrer → meta / social", eq(A({ clickId: "fbclid" }), "meta", "social"));

console.log("\nrules: searches, devices, geography, rate key, environments");
t("12. a search term is lower-cased and bounded", normalizeSearchTerm("  Kasavu   SAREE ") === "kasavu saree" && normalizeSearchTerm("x".repeat(300))!.length === 64);
t("20. an email typed into search is redacted", normalizeSearchTerm("asha@example.com") === REDACTED_TERM);
t("20. a phone number typed into search is redacted", normalizeSearchTerm("call 98470 12345") === REDACTED_TERM);
t("20. an order-like number is redacted", normalizeSearchTerm("order 123456") === REDACTED_TERM);
t("a size number is kept", normalizeSearchTerm("ring size 6") === "ring size 6");
t("36. iPhone mobile, Mac desktop, Android tablet tablet", deviceFor(UA_PHONE) === "mobile" && deviceFor(UA_DESKTOP) === "desktop" && deviceFor(UA_TABLET) === "tablet");
t("Lighthouse, curl, GPTBot, OAI-SearchBot and an empty UA are not visitors",
  isBot(UA_LIGHTHOUSE) && isBot("curl/8.4.0") && isBot(UA_GPTBOT) && isBot(UA_OAI) && isBot(null) && !isBot(UA_PHONE) && !isBot(UA_DESKTOP));
const h = (o: Record<string, string>) => new Headers(o);
const g = geoFor(h({ "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "KL", "x-vercel-ip-city": "Kochi" }));
t("37. country and region read; city ignored", g.country_code === "IN" && g.region === "KL" && !("city" in g));
t("22. no geo headers → null, not a guess", geoFor(h({})).country_code === null && geoFor(h({})).region === null);
t("22. malformed geo → null", geoFor(h({ "x-vercel-ip-country": "India", "x-vercel-ip-country-region": "Kerala" })).country_code === null);
t("21. the rate key is an HMAC that rotates daily",
  /^[0-9a-f]{64}$/.test(rateKey("1.2.3.4", "s")) &&
  rateKey("1.2.3.4", "s", new Date("2026-10-11T10:00Z")) !== rateKey("1.2.3.4", "s", new Date("2026-10-12T10:00Z")) &&
  rateKey("1.2.3.4", "s") !== rateKey("1.2.3.4", "other-secret") && !rateKey("1.2.3.4", "s").includes("1.2.3.4"));
t("10. production deployment → production", deploymentMode({ VERCEL_ENV: "production" }) === "production");
t("10. preview → off", deploymentMode({ VERCEL_ENV: "preview" }) === "off");
t("10. local → off", deploymentMode({}) === "off");
t("10. deliberate non-prod test → test", deploymentMode({ VERCEL_ENV: "preview", ANALYTICS_ALLOW_NONPROD: "1" }) === "test");
t("the public build flag does not switch the server on", deploymentMode({ NEXT_PUBLIC_ANALYTICS_ENABLED: "1" }) === "off");
t("opt-out: cookie or GPC", optedOut("1", null) && optedOut(undefined, "1") && !optedOut(undefined, null) && !optedOut("0", "0"));

(async () => {
  // ── Handler ──────────────────────────────────
  console.log("\nhandler: POST /api/events with the database faked");
  type Call = { key: string; context: IngestContext; events: CleanEvent[] };
  const calls: Call[] = [];
  let limited = false;
  let broken = false;
  const PROD = { VERCEL_ENV: "production" };
  const deps = (env: Record<string, string> = PROD): EventsDeps => ({
    env,
    secret: "test-secret",
    ingest: async (key, context, events) => {
      if (broken) throw new Error("db down");
      calls.push({ key, context, events });
      return { collecting: true, accepted: events.length, duplicates: 0, skipped: 0, limited };
    },
  });
  const req = (body: unknown, o: { ua?: string; cookies?: Record<string, string>; origin?: string; method?: string; headers?: Record<string, string> } = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      method: o.method ?? "POST",
      url: "https://www.thewovenne.com/api/events",
      headers: new Headers({
        "user-agent": o.ua ?? UA_PHONE,
        "content-length": String(text.length),
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        "x-vercel-ip-country": "IN",
        "x-vercel-ip-country-region": "KL",
        ...(o.origin ? { origin: o.origin } : {}),
        ...(o.headers ?? {}),
      }),
      cookie: (n: string) => o.cookies?.[n],
      text: async () => text,
    };
  };
  const pv = { events: [{ type: "page_view", path: "/in" }] };

  let r = await handleEvents(req(pv), deps({ VERCEL_ENV: "preview" }));
  t("10. preview → 204 and the database is never asked", r.status === 204 && calls.length === 0);
  r = await handleEvents(req(pv), deps({}));
  t("10. local → 204 and the database is never asked", r.status === 204 && calls.length === 0);
  r = await handleEvents(req(pv), deps({ NEXT_PUBLIC_ANALYTICS_ENABLED: "1" }));
  t("10. the public flag alone does not make a non-production server write", r.status === 204 && calls.length === 0);
  r = await handleEvents(req(pv, { method: "GET" }), deps());
  t("GET → 405", r.status === 405);

  r = await handleEvents(req(pv, { origin: "https://www.thewovenne.com" }), deps());
  const c1 = calls.at(-1);
  t("1. production page view reaches ingest", r.status === 204 && calls.length === 1);
  t("1. context is exactly device, country, region, traffic", JSON.stringify(Object.keys(c1?.context ?? {}).sort()) === JSON.stringify(["country_code", "device", "region", "traffic"]));
  t("customer traffic, mobile, IN / KL", c1?.context.traffic === "customer" && c1?.context.device === "mobile" && c1?.context.country_code === "IN" && c1?.context.region === "KL");
  t("21. the raw IP and User-Agent never leave the handler", !JSON.stringify(c1).includes("203.0.113.9") && !JSON.stringify(c1).includes(UA_PHONE));

  r = await handleEvents(req(pv), deps({ VERCEL_ENV: "preview", ANALYTICS_ALLOW_NONPROD: "1" }));
  t("10. a deliberate non-prod test is labelled test", calls.at(-1)?.context.traffic === "test");
  r = await handleEvents(req(pv, { cookies: { wv_internal: "1" } }), deps());
  t("9. a staff browser is internal", calls.at(-1)?.context.traffic === "internal");

  let before = calls.length;
  r = await handleEvents(req(pv, { cookies: { wv_stats_off: "1" } }), deps());
  t("opt-out cookie → 204, nothing sent to the database", r.status === 204 && calls.length === before);
  r = await handleEvents(req(pv, { headers: { "sec-gpc": "1" } }), deps());
  t("Global Privacy Control → 204, nothing sent to the database", r.status === 204 && calls.length === before);

  r = await handleEvents(req(pv, { origin: "https://evil.example" }), deps());
  t("another site's origin → 403", r.status === 403);
  r = await handleEvents(req(pv, { origin: "null" }), deps());
  t("a null origin → 403", r.status === 403);
  r = await handleEvents(req("x".repeat(MAX_BODY_BYTES + 1)), deps());
  t("5. oversized body → 413", r.status === 413);
  r = await handleEvents(req(pv, { headers: { "content-length": "999999" } }), deps());
  t("5. oversized declared length → 413", r.status === 413);
  r = await handleEvents(req("{not json"), deps());
  t("6. malformed JSON → 400", r.status === 400);
  before = calls.length;
  r = await handleEvents(req({ events: [{ type: "page_view", path: "/in", user_id: "00000000-0000-0000-0000-000000000001" }] }), deps());
  t("3. spoofed user id → 400, nothing stored", r.status === 400 && calls.length === before);
  r = await handleEvents(req({ events: [{ type: "purchase", path: "/in" }] }), deps());
  t("18. browser purchase → 400", r.status === 400 && calls.length === before);
  for (const [name, ua] of [["Lighthouse", UA_LIGHTHOUSE], ["GPTBot", UA_GPTBOT], ["OAI-SearchBot", UA_OAI]]) {
    r = await handleEvents(req(pv, { ua }), deps());
    t(`${name} → 204, nothing stored`, r.status === 204 && calls.length === before);
  }
  limited = true;
  r = await handleEvents(req(pv), deps());
  t("7. rate limited → 429", r.status === 429);
  limited = false;
  broken = true;
  r = await handleEvents(req(pv), deps());
  t("database refusal → 503, not a crash", r.status === 503);
  broken = false;

  // ── Purchase helper ──────────────────────────
  console.log("\npurchase: settlement's call");
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const fakeDb = (mode: "ok" | "error" | "throw") =>
    ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (mode === "throw") throw new Error("network");
        return mode === "error" ? { data: null, error: { message: "boom" } } : { data: "recorded", error: null };
      },
    }) as never;
  t("preview/local settlement never records", (await recordPurchase(fakeDb("ok"), P, { VERCEL_ENV: "preview" })) === "not_production" && rpcCalls.length === 0);
  await recordPurchase(fakeDb("ok"), P, { VERCEL_ENV: "production", RAZORPAY_KEY_ID: "rzp_test_abc" });
  t("production on Razorpay TEST keys → test_mode true", rpcCalls.at(-1)?.args.p_test_mode === true && rpcCalls.at(-1)?.fn === "analytics_record_purchase");
  await recordPurchase(fakeDb("ok"), P, { VERCEL_ENV: "production", RAZORPAY_KEY_ID: "rzp_live_abc" });
  t("production on live keys → test_mode false", rpcCalls.at(-1)?.args.p_test_mode === false);
  await recordPurchase(fakeDb("ok"), P, { VERCEL_ENV: "production" });
  t("no key at all → test_mode true (cannot inflate demand)", rpcCalls.at(-1)?.args.p_test_mode === true);
  t("only the order id and mode are sent — no customer data", JSON.stringify(Object.keys(rpcCalls.at(-1)!.args).sort()) === JSON.stringify(["p_order_id", "p_test_mode"]));
  t("an error never throws into settlement", (await recordPurchase(fakeDb("error"), P, PROD)) === "error" && (await recordPurchase(fakeDb("throw"), P, PROD)) === "error");

  // ── Browser ───────────────────────────────────
  console.log("\nbrowser: lib/analyticsClient against a fake page");
  const beacons: string[] = [];
  const jar = new Map<string, string>();
  const cookieWrites: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const loc = { hostname: "www.thewovenne.com", pathname: "/in", search: "?utm_source=Instagram&utm_campaign=onam&gclid=SECRETCLICK&email=a@b.c" };
  const fakeDoc = {
    referrer: "https://l.instagram.com/?u=https%3A%2F%2Fwww.thewovenne.com%2Fin&e=secret",
    visibilityState: "visible",
    addEventListener: (n: string, f: () => void) => (listeners[n] ??= []).push(f),
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(v: string) {
      cookieWrites.push(v);
      const [pair, ...attrs] = v.split("; ");
      const [k, val] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.includes("Max-Age=0")) jar.delete(k);
      else jar.set(k, val);
    },
  };
  const nav: { webdriver: boolean; globalPrivacyControl?: boolean; sendBeacon: (u: string, b: Blob) => boolean } = {
    webdriver: false,
    sendBeacon: (_u, b) => {
      void b.text().then((x) => beacons.push(x));
      return true;
    },
  };
  Object.defineProperty(globalThis, "window", { value: { location: loc, addEventListener: (n: string, f: () => void) => (listeners[n] ??= []).push(f) }, configurable: true });
  Object.defineProperty(globalThis, "document", { value: fakeDoc, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
  process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "1";
  const client = await import("../lib/analyticsClient");
  const flushNow = async () => {
    listeners.pagehide?.forEach((f) => f());
    await new Promise((res) => setTimeout(res, 10));
  };
  const sent = () => beacons.flatMap((b) => JSON.parse(b).events as Record<string, unknown>[]);

  client.trackPageView();
  client.trackPageView();
  client.trackPageView();
  await flushNow();
  let ev = sent();
  t("1. one page view however often the effect runs", ev.filter((e) => e.type === "page_view").length === 1);
  t("the entry carries referrer HOST, UTMs and the click-id NAME", ev[0]?.is_entry === true && ev[0]?.referrer_host === "l.instagram.com" && ev[0]?.utm_source === "Instagram" && ev[0]?.click_id === "gclid");
  t("20. no query string, click-id value, other params or referrer URL leave the page",
    !beacons.join("").includes("a@b.c") && !beacons.join("").includes("secret") && !beacons.join("").includes("SECRETCLICK") && ev[0]?.path === "/in");
  t("every batch passes the server's rules", beacons.every((b) => parseBatch(JSON.parse(b)).ok));
  t("NO cookie or identifier is written by collecting", cookieWrites.length === 0 && jar.size === 0);

  beacons.length = 0;
  loc.pathname = "/in/women/sarees/black-line-border";
  client.trackPageView();
  client.trackOncePerPage(`product:${P}`, "product_view", { product_id: P });
  client.trackOncePerPage(`product:${P}`, "product_view", { product_id: P });
  await flushNow();
  ev = sent();
  t("11. product view once per page view, despite re-runs", ev.filter((e) => e.type === "product_view").length === 1);
  t("later events keep the page load's attribution but are not entries",
    ev.every((e) => e.utm_source === "Instagram") && ev.find((e) => e.type === "page_view")?.is_entry === undefined);

  beacons.length = 0;
  loc.pathname = "/in/shop";
  client.trackPageView();
  loc.pathname = "/in/women/sarees/black-line-border";
  client.trackPageView();
  client.trackOncePerPage(`product:${P}`, "product_view", { product_id: P });
  await flushNow();
  t("11. coming back to the product is a new view", sent().filter((e) => e.type === "product_view").length === 1 && sent().filter((e) => e.type === "page_view").length === 2);

  beacons.length = 0;
  client.track("cart_add", { product_id: P, quantity: 250 });
  client.track("cart_remove", { product_id: "not-a-uuid", quantity: 1 });
  client.track("cart_remove", { product_id: P, quantity: 1 });
  client.track("wishlist_add", { product_id: P });
  await flushNow();
  ev = sent();
  t("13/15/16. wishlist and cart events sent; quantity clamped; a bad id dropped",
    ev.length === 3 && ev[0].type === "cart_add" && ev[0].quantity === 99 && ev[1].type === "cart_remove" && ev[2].type === "wishlist_add");
  t("8. every event carries its own id (retries dedupe)", new Set(ev.map((e) => e.client_event_id)).size === ev.length);

  beacons.length = 0;
  for (let i = 0; i < 25; i++) client.track("whatsapp_click");
  await flushNow();
  t("batched: 25 events leave in ≤ 3 requests of ≤ 20", beacons.length <= 3 && beacons.every((b) => JSON.parse(b).events.length <= 20) && sent().length === 25);

  console.log("\nbrowser: opting out");
  beacons.length = 0;
  client.track("whatsapp_click"); // queued…
  client.setStatisticsOff(true); // …then the visitor turns statistics off
  client.track("whatsapp_click");
  await flushNow();
  t("turning statistics off sends nothing — including what was already queued", beacons.length === 0);
  t("the opt-out cookie holds only the choice", jar.get("wv_stats_off") === "1" && /Max-Age=31536000; Path=\/; SameSite=Lax; Secure/.test(cookieWrites.at(-1) ?? ""));
  t("statisticsOff() reads it", client.statisticsOff());
  client.setStatisticsOff(false);
  client.track("whatsapp_click");
  await flushNow();
  t("turning it back on resumes, and removes the cookie", beacons.length === 1 && !jar.has("wv_stats_off"));
  beacons.length = 0;
  nav.globalPrivacyControl = true;
  client.track("whatsapp_click");
  await flushNow();
  t("Global Privacy Control → nothing sent", beacons.length === 0 && client.statisticsOff());
  nav.globalPrivacyControl = false;

  beacons.length = 0;
  nav.webdriver = true;
  client.track("whatsapp_click");
  await flushNow();
  t("an automated browser (Lighthouse, Playwright) sends nothing", beacons.length === 0);
  nav.webdriver = false;
  loc.hostname = "the-wovenne-git-x.vercel.app";
  client.track("whatsapp_click");
  await flushNow();
  t("10. a preview host sends nothing", beacons.length === 0);
  loc.hostname = "localhost";
  client.track("whatsapp_click");
  await flushNow();
  t("10. localhost sends nothing", beacons.length === 0);
  t("PRODUCTION_HOST matches lib/seo", `https://${client.PRODUCTION_HOST}` === PRODUCTION_ORIGIN);

  // ── Wiring ────────────────────────────────────
  console.log("\nwiring");
  const read = (f: string) => fs.readFileSync(f, "utf8");
  const clientSrc = read("lib/analyticsClient.ts");
  t("performance: the browser client imports nothing but cookie names", [...clientSrc.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]).join() === "./analyticsCookies");
  t("performance: no Supabase, no SDK, no Google tag in the browser analytics",
    !/supabase|@vercel|gtag|googletagmanager|fbq/.test(read("components/analytics/AnalyticsTracker.tsx") + read("components/analytics/AnalyticsBeacon.tsx") + read("components/analytics/StatisticsChoice.tsx") + clientSrc));
  t("the tracker does not use useSearchParams (no CSR bail-out)", !read("components/analytics/AnalyticsTracker.tsx").includes("useSearchParams"));
  const layout = read("app/(storefront)/layout.tsx");
  t("the tracker is the storefront layout's first child", layout.indexOf("<AnalyticsTracker />") > 0 && layout.indexOf("<AnalyticsTracker />") < layout.indexOf("<Navbar />"));
  t("admin layout has no tracker", !read("app/(admin)/layout.tsx").includes("Analytics"));
  t("11. both product routes count a view (via ProductDetail)", read("components/product/ProductDetail.tsx").includes('<AnalyticsBeacon event="product_view" productId={product.id} />'));
  t("12. search counted only once a search was made", /searched && \(\s*<AnalyticsBeacon event="search"/.test(read("app/(storefront)/in/search/page.tsx")));
  t("17. checkout start waits for the hydrated bag", /hydrated && items\.length > 0[\s\S]{0,200}trackOncePerPage\("checkout", "checkout_start"\)/.test(read("components/cart/CheckoutForm.tsx")));
  const store = read("lib/store.ts");
  t("15. cart_add counted from what actually went in", store.includes('if (after > before) track("cart_add"'));
  t("16. cart_remove on remove and on stepping to zero", (store.match(/track\("cart_remove"/g) ?? []).length === 2);
  const wl = read("lib/wishlistStore.ts");
  t("13/14. wishlist events only after the database accepted the change",
    wl.indexOf('track(saved ? "wishlist_remove" : "wishlist_add"') > wl.indexOf('return "error";\n        }'));
  const settle = read("lib/settleOrder.ts");
  t("18. settlement records the purchase on both paid paths", (settle.match(/await recordPurchase\(supabase, orderId\)/g) ?? []).length === 2 && settle.includes("if (markedPaid) await recordPurchase"));
  t("9. middleware marks a verified admin's browser internal", /INTERNAL_COOKIE, "1"/.test(read("middleware.ts")));
  t("the collector uses the service role only server-side", read("app/api/events/route.ts").includes("createServiceClient") && !clientSrc.includes("SERVICE_ROLE"));
  const everything = ["lib/analyticsClient.ts", "lib/analyticsCollect.ts", "lib/analyticsIngest.ts", "lib/analyticsCookies.ts", "app/api/events/route.ts", "middleware.ts"].map(read).join("\n");
  t("no visitor/session identifier code remains", !/wv_vid|wv_consent|visitor_id|session_id|getUserId/.test(everything));
  const page = read("app/(storefront)/in/cookies/page.tsx");
  const names = [
    ["wovenne-cart", read("lib/store.ts")],
    ["wovenne-payment-hold", read("lib/paymentOutcome.ts")],
    ["wv_stats_off", read("lib/analyticsCookies.ts")],
    ["wv_internal", read("lib/analyticsCookies.ts")],
    ["wv_admin_active", read("lib/adminSession.ts")],
    ["wovenne-export-columns", read("components/admin/ExportPanel.tsx")],
  ];
  t("the cookie page names only storage the code really uses", names.every(([n, src]) => page.includes(n) && src.includes(`"${n}"`)));
  t("the cookie page carries the opt-out control and says statistics are not for advertising",
    page.includes("<StatisticsChoice />") && page.includes("an advertising tracker") && page.includes("Global Privacy Control"));
  const { choiceCopy } = await import("../components/analytics/StatisticsChoice");
  const all = [false, true].flatMap((off) => [false, true].flatMap((gpc) => [false, true].map((siteCollecting) => ({ off, gpc, siteCollecting, copy: choiceCopy({ off, gpc, siteCollecting }) }))));
  t("cookie page: the preference sentence never claims collection is happening",
    all.every(({ copy }) => /^Your preference on this device: usage statistics (allowed|off)\.$/.test(copy.preference)));
  t("cookie page: while the site is not collecting, every state says so",
    all.every(({ siteCollecting, copy }) => siteCollecting === !copy.detail.includes("We are not collecting usage statistics at the moment")));
  t("cookie page: allowed / off / GPC read correctly",
    choiceCopy({ off: false, gpc: false, siteCollecting: true }).preference.endsWith("allowed.") &&
    choiceCopy({ off: true, gpc: false, siteCollecting: true }).preference.endsWith("off.") &&
    choiceCopy({ off: false, gpc: true, siteCollecting: true }).preference.endsWith("off.") &&
    choiceCopy({ off: false, gpc: true, siteCollecting: true }).button === null &&
    choiceCopy({ off: true, gpc: false, siteCollecting: false }).button === "Allow statistics" &&
    choiceCopy({ off: false, gpc: false, siteCollecting: false }).button === "Turn statistics off");
  t("siteCollectsStatistics() follows the public build flag", client.siteCollectsStatistics() === true);
  t("the cookie page makes no 'exempt from consent' claim", !/exempt|no consent (is )?(needed|required)/i.test(page));
  t("/in/cookies is in the sitemap", read("lib/sitemapRoutes.ts").includes('{ path: "/cookies", priority: 0.3 }'));
  t("robots.txt rules untouched by this work", read("app/robots.ts").includes("/admin") && !/OAI|GPTBot/.test(read("app/robots.ts")));
  const sw = read("scripts/analytics-switch.mjs");
  t("the switch script changes only analytics_config", (sw.match(/update public\.\w+/g) ?? []).every((m) => m === "update public.analytics_config"));
  t("23. no gender, IP, UA, city, coordinates or identity column in 0068",
    !/^\s+(gender|inferred_gender|predicted_gender|ip|ip_address|user_agent|city|latitude|longitude|visitor_id|session_id|user_id|customer_email)\s/im.test(read("supabase/migrations/0068_analytics_foundation.sql")));

  // ── Database ──────────────────────────────────
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database half — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (DB SKIPPED)\n`);
    process.exit(fail ? 1 : 2);
  }
  let c: Client | null = null;
  try {
    await engine.database("w");
    c = await engine.connect("w");
    await database(c);
  } catch (e) {
    t("database half ran", false, (e as Error).message);
  } finally {
    await c?.end();
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

async function database(c: Client) {
  console.log("\ndatabase: OFF means zero rows from every source");
  await asRoot(c);
  const cat = (await c.query("insert into categories (name, slug) values ('Test sarees', 'test-analytics-sarees') returning id")).rows[0].id as string;
  const prod = (await c.query("insert into products (name, slug, price_inr, category_id) values ('Kasavu', 'test-analytics-kasavu', 1000, $1) returning id", [cat])).rows[0].id as string;
  const admin = await makeAdmin(c, "staff@thewovenne.test");
  const cust = (await c.query("insert into auth.users (email) values ('asha@example.test') returning id")).rows[0].id as string;
  await c.query("insert into profiles (id, email) values ($1, 'asha@example.test') on conflict do nothing", [cust]);

  const KEY = "a".repeat(64);
  const ctx = (o: Record<string, unknown> = {}) => JSON.stringify({ device: "mobile", country_code: "IN", region: "KL", traffic: "customer", ...o });
  const ingest = async (events: unknown[], o: Record<string, unknown> = {}, key = KEY) => {
    await asService(c);
    const r = (await c.query("select analytics_ingest($1, $2::jsonb, $3::jsonb) r", [key, ctx(o), JSON.stringify(events)])).rows[0].r;
    await asRoot(c);
    return r as { collecting: boolean; accepted: number; duplicates: number; skipped: number; limited: boolean };
  };
  const purchase = async (orderId: string, test: boolean | null = false) => {
    await asService(c);
    const r = (await c.query("select analytics_record_purchase($1, $2) r", [orderId, test])).rows[0].r as string;
    await asRoot(c);
    return r;
  };
  const rows = async (tbl = "analytics_events", where = "true", args: unknown[] = []) => {
    await asRoot(c);
    return Number((await c.query(`select count(*) n from ${tbl} where ${where}`, args)).rows[0].n);
  };
  const order = async (email: string, method: string | null, status = "pending") =>
    (await c.query("insert into orders (customer_email, total_inr, payment_status, payment_method, items) values ($1, 1000, $2, $3, '[]') returning id", [email, status, method])).rows[0].id as string;
  const switchTo = async (on: boolean) => {
    await asRoot(c);
    await c.query("update analytics_config set collecting = $1, changed_at = now() where id", [on]);
  };

  t("a fresh migration starts OFF", (await c.query("select collecting from analytics_config")).rows[0].collecting === false);
  const off1 = await ingest([{ type: "page_view", path: "/in" }, { type: "cart_add", path: "/in/p", product_id: prod, quantity: 1 }, { type: "wishlist_add", path: "/in/p", product_id: prod }]);
  t("OFF: browser events → collecting false, nothing accepted", off1.collecting === false && off1.accepted === 0);
  const paidOff = await order("asha@example.test", "razorpay", "paid");
  t("OFF: a paid online order → 'off'", (await purchase(paidOff)) === "off");
  await asUser(c, cust, "aal1");
  await c.query("insert into wishlists (user_id, product_id) values ($1, $2)", [cust, prod]);
  await c.query("delete from wishlists where user_id = $1", [cust]);
  await asRoot(c);
  await c.query("update orders set payment_status = 'pending' where id = $1", [paidOff]);
  await c.query("update orders set payment_status = 'paid' where id = $1", [paidOff]);
  t("OFF: zero rows in analytics_events after browser, wishlist, order and purchase activity", (await rows()) === 0);
  t("OFF: not even a rate-limiter row", (await rows("analytics_rate")) === 0);
  t("no trigger on wishlists or orders writes analytics (no DB-originated path)",
    Number((await c.query("select count(*) n from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname like 'analytics%'")).rows[0].n) === 0);
  await c.query("delete from analytics_config");
  t("no config row at all reads as OFF (fails closed)", (await ingest([{ type: "page_view", path: "/in" }])).collecting === false && (await rows()) === 0);
  await c.query("insert into analytics_config (id, collecting) values (true, false)");

  console.log("\ndatabase: who can touch the switch");
  await asService(c);
  t("service_role cannot read or change the switch",
    (await failure(() => c.query("update analytics_config set collecting = true"))).includes("permission denied") &&
    (await failure(() => c.query("select * from analytics_config"))).includes("permission denied"));
  await asRoot(c);
  await asAdmin(c, admin);
  t("even a verified admin cannot change the switch through the API", (await failure(() => c.query("update analytics_config set collecting = true"))).includes("permission denied"));
  await asRoot(c);
  await c.query("set role anon");
  t("anon cannot ask whether collection is on", (await failure(() => c.query("select analytics_collecting()"))).includes("permission denied"));
  await asRoot(c);

  console.log("\ndatabase: ON");
  await switchTo(true);
  let r = await ingest([{ type: "page_view", path: "/in", is_entry: true, source: "instagram", medium: "social", referrer_host: "l.instagram.com", utm_campaign: "onam", utm_content: "reel", utm_term: "kasavu" }]);
  t("1. anonymous page view stored", r.collecting && r.accepted === 1 && (await rows("analytics_events", "event_type = 'page_view' and is_entry")) === 1);
  t("attribution stored: source, medium, host, campaign, content, term",
    (await rows("analytics_events", "source = 'instagram' and medium = 'social' and utm_campaign = 'onam' and utm_content = 'reel' and utm_term = 'kasavu'")) === 1);
  t("37. region stored with country", (await rows("analytics_events", "country_code = 'IN' and region = 'KL'")) === 1);
  await ingest([{ type: "product_view", path: "/in/p", product_id: prod }]);
  t("11. product view stored with the category taken from the product", (await rows("analytics_events", "event_type = 'product_view' and product_id = $1 and category_id = $2", [prod, cat])) === 1);
  r = await ingest([{ type: "product_view", path: "/in/p", product_id: "00000000-0000-4000-8000-000000000000" }]);
  t("a product that does not exist is skipped", r.skipped === 1 && r.accepted === 0);
  r = await ingest([{ type: "purchase", path: "/in" }]);
  t("18. purchase cannot come through ingest", r.skipped === 1 && (await rows("analytics_events", "event_type = 'purchase'")) === 0);
  await ingest([{ type: "wishlist_add", path: "/in/p", product_id: prod }, { type: "wishlist_remove", path: "/in/p", product_id: prod }]);
  t("13/14. wishlist add and remove stored", (await rows("analytics_events", "event_type like 'wishlist_%' and product_id = $1", [prod])) === 2);
  await ingest([{ type: "search", path: "/in/search", search_term: "kasavu", result_count: 0 }]);
  t("12. search stored with term and result count (zero-result searches reportable)", (await rows("analytics_events", "event_type = 'search' and search_term = 'kasavu' and result_count = 0 and region = 'KL'")) === 1);
  await ingest([{ type: "cart_add", path: "/in/p", product_id: prod, quantity: 2 }, { type: "cart_remove", path: "/in/cart", product_id: prod, quantity: 1 }]);
  t("15/16. cart add and remove stored with quantity", (await rows("analytics_events", "event_type = 'cart_add' and quantity = 2")) === 1 && (await rows("analytics_events", "event_type = 'cart_remove' and quantity = 1")) === 1);
  await ingest([{ type: "checkout_start", path: "/in/checkout" }, { type: "whatsapp_click", path: "/in" }]);
  t("17. checkout start and WhatsApp click stored", (await rows("analytics_events", "event_type in ('checkout_start','whatsapp_click')")) === 2);
  const EID = "11111111-1111-4111-8111-111111111111";
  await ingest([{ type: "page_view", path: "/in/d", client_event_id: EID }]);
  r = await ingest([{ type: "page_view", path: "/in/d", client_event_id: EID }]);
  t("8. a retried beacon is stored once", r.duplicates === 1 && (await rows("analytics_events", "client_event_id = $1", [EID])) === 1);
  await ingest([{ type: "page_view", path: "/in/staff" }], { traffic: "internal" });
  await ingest([{ type: "page_view", path: "/in/test" }], { traffic: "test" });
  t("9. internal and test traffic are labelled", (await rows("analytics_events", "path = '/in/staff' and traffic = 'internal'")) === 1 && (await rows("analytics_events", "path = '/in/test' and traffic = 'test'")) === 1);
  t("6. 21 events in one call is refused", (await failure(() => ingest(Array.from({ length: 21 }, () => ({ type: "page_view", path: "/in" }))))).includes("at most 20"));
  t("6. a bad device value is refused by the table", (await failure(() => ingest([{ type: "page_view", path: "/in" }], { device: "fridge" }))).length > 0);
  t("6. an order id on a non-purchase is refused by the table",
    (await failure(() => c.query("insert into analytics_events (event_type, order_id) values ('page_view', $1)", [paidOff]))).includes("order_only_on_purchase"));

  const K2 = "b".repeat(64);
  let limitedAt = -1;
  for (let i = 0; i < 8; i++) {
    const x = await ingest(Array.from({ length: 20 }, () => ({ type: "page_view", path: "/in/r" })), {}, K2);
    if (x.limited && limitedAt < 0) limitedAt = i;
  }
  t("7. 120 events a minute per key, then refused", limitedAt === 6 && (await rows("analytics_events", "path = '/in/r'")) === 120);
  t("7. another key is unaffected", !(await ingest([{ type: "page_view", path: "/in" }], {}, "c".repeat(64))).limited);
  await c.query("update analytics_rate set window_start = now() - interval '2 minutes' where rate_key = $1", [K2]);
  t("7. the window resets after a minute", !(await ingest([{ type: "page_view", path: "/in/r" }], {}, K2)).limited);
  await c.query("update analytics_rate set window_start = now() - interval '11 minutes'");
  await ingest([{ type: "page_view", path: "/in" }], {}, "d".repeat(64));
  t("21. rate-limiter rows are swept after 10 minutes", (await rows("analytics_rate")) === 1);

  console.log("\ndatabase: purchases");
  const pending = await order("asha@example.test", "razorpay");
  t("18. a pending order is not a purchase", (await purchase(pending)) === "not_paid");
  await c.query("update orders set payment_status = 'paid' where id = $1", [pending]);
  t("18. a paid online order on live keys is a customer purchase", (await purchase(pending, false)) === "recorded" && (await rows("analytics_events", "order_id = $1 and traffic = 'customer'", [pending])) === 1);
  t("18. browser callback + webhook + replay → still one", (await purchase(pending, false)) === "duplicate" && (await purchase(pending, false)) === "duplicate" && (await rows("analytics_events", "order_id = $1", [pending])) === 1);
  t("the purchase row carries no customer data", (await rows("analytics_events", "order_id = $1 and path is null and country_code is null and product_id is null", [pending])) === 1);
  const cash = await order("walk-in@example.test", "cash", "paid");
  t("an in-person sale is not a web purchase", (await purchase(cash)) === "not_online" && (await rows("analytics_events", "order_id = $1", [cash])) === 0);
  const staffOrder = await order("STAFF@thewovenne.test", "razorpay", "paid");
  await purchase(staffOrder, false);
  t("9. a purchase by a staff email is internal", (await rows("analytics_events", "order_id = $1 and traffic = 'internal'", [staffOrder])) === 1);
  const testOrder = await order("asha@example.test", "razorpay", "paid");
  await purchase(testOrder, true);
  const unknownMode = await order("asha@example.test", "razorpay", "paid");
  await purchase(unknownMode, null);
  t("a Razorpay test payment (or unknown mode) is test traffic", (await rows("analytics_events", "order_id in ($1, $2) and traffic = 'test'", [testOrder, unknownMode])) === 2);
  t("a missing order → no_order", (await purchase("00000000-0000-4000-8000-000000000000")) === "no_order");

  console.log("\ndatabase: OFF again");
  await switchTo(false);
  const n = await rows();
  const late = await order("asha@example.test", "razorpay", "paid");
  const r2 = await ingest([{ type: "page_view", path: "/in/after-off" }]);
  t("switching OFF stops every source immediately", r2.collecting === false && (await purchase(late, false)) === "off" && (await rows()) === n);
  await switchTo(true);

  console.log("\ndatabase: who can read and write");
  const deniedAll = async (label: string) => {
    for (const tbl of ["analytics_events", "analytics_rate", "analytics_config"]) {
      const sel = await failure(() => c.query(`select 1 from ${tbl} limit 1`));
      const ins = await failure(() => c.query(`insert into ${tbl} default values`));
      if (!sel.includes("permission denied") || !ins.includes("permission denied")) {
        t(`${label}: no access to ${tbl}`, false, `${sel} / ${ins}`);
        return;
      }
    }
    const ing = await failure(() => c.query("select analytics_ingest($1, '{}'::jsonb, '[]'::jsonb)", [KEY]));
    const pur = await failure(() => c.query("select analytics_record_purchase($1, false)", [pending]));
    t(`${label}: cannot read/write raw analytics, the switch, ingest or record a purchase`, ing.includes("permission denied") && pur.includes("permission denied"));
  };
  await c.query("set role anon");
  await deniedAll("24. anonymous");
  await asRoot(c);
  await asUser(c, cust, "aal1");
  await deniedAll("25. customer");
  const diag = (from = "now() - interval '1 day'", to = "now() + interval '1 hour'") => c.query(`select analytics_diagnostics(${from}, ${to}) d`);
  t("26. customer cannot read admin diagnostics", (await failure(() => diag())).includes("Only admins"));
  t("26. customer cannot purge", (await failure(() => c.query("select analytics_purge(180)"))).includes("permission denied"));
  await asRoot(c);
  await c.query("set role authenticated"); // no claims at all
  t("the read gate is never NULL (0025's gate failed open without a role claim)",
    (await c.query("select public.can_read_analytics() v")).rows[0].v === false &&
    (await failure(() => diag())).includes("Only admins") &&
    (await failure(() => c.query("select analytics_summary(30)"))).includes("Only admins"));
  await asRoot(c);
  await asStaffPasswordOnly(c, admin);
  t("29. staff without the second factor cannot read diagnostics", (await failure(() => diag())).includes("Only admins"));
  await asRoot(c);
  await asAdmin(c, admin);
  const d = (await diag()).rows[0].d;
  t("27. a verified admin can read diagnostics, including the switch state", Array.isArray(d.by_type) && d.by_type.length > 0 && d.collecting === true);
  t("diagnostics separate customer / internal / test", ["customer", "internal", "test"].every((tr) => d.by_type.some((x: { traffic: string }) => x.traffic === tr)));
  t("diagnostics carry counts only — no ids", !JSON.stringify(d).match(/[0-9a-f]{8}-[0-9a-f]{4}-/));
  t("27. a verified admin still cannot read the raw table", (await failure(() => c.query("select 1 from analytics_events"))).includes("permission denied"));
  t("diagnostics refuse an absurd window", (await failure(() => diag("now()", "now() - interval '1 day'"))).includes("invalid window"));
  const flaggedBefore = d.purchases_no_longer_paid as number;
  await asRoot(c);
  await c.query("update orders set payment_status = 'refunded' where id = $1", [pending]);
  await asAdmin(c, admin);
  t("diagnostics flag a purchase whose order is no longer paid", ((await diag()).rows[0].d.purchases_no_longer_paid as number) === flaggedBefore + 1);
  const claims = (await c.query("select current_setting('request.jwt.claims') c")).rows[0].c as string;
  await c.query("reset role");
  await c.query("delete from auth.sessions where user_id = $1", [admin]);
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [admin, claims]);
  t("28/29. the same token after its session ended (0067) cannot read diagnostics", (await failure(() => diag())).includes("Only admins"));
  await asRoot(c);

  console.log("\ndatabase: retention and schema");
  await c.query("update analytics_events set occurred_at = now() - interval '200 days' where path = '/in/r'");
  await asService(c);
  t("purge refuses to keep less than 30 days", (await failure(() => c.query("select analytics_purge(7)"))).includes("at least 30"));
  const purged = (await c.query("select analytics_purge(180) p")).rows[0].p;
  await asRoot(c);
  t("purge removes raw events past 180 days", purged.events === 121 && (await rows("analytics_events", "path = '/in/r'")) === 0);
  const cols = (await c.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'analytics_events' order by 1")).rows.map((x) => x.column_name as string);
  t("19–23. no identity, token, password, IP, UA, city, coordinates, email or gender column",
    !cols.some((x) => /visitor|session|user_id|token|password|^ip|user_agent|city|latitude|longitude|email|gender|form/.test(x)), cols.join(","));
  t("22. country and region are nullable", (await c.query("select bool_and(is_nullable = 'YES') n from information_schema.columns where table_name = 'analytics_events' and column_name in ('country_code','region')")).rows[0].n === true);
  t("29. diagnostics gate is can_read_analytics → hardened is_admin()",
    /can_read_analytics\(\)/.test((await c.query("select prosrc from pg_proc where proname = 'analytics_diagnostics'")).rows[0].prosrc) &&
    /is_admin\(\)/.test((await c.query("select prosrc from pg_proc where proname = 'can_read_analytics'")).rows[0].prosrc));
}

/**
 * Analytics foundation (1A): what the collector accepts, what the browser
 * sends, and what the database stores and lets each role do.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/analytics-foundation.test.ts
 *
 * Four halves:
 *   rules     lib/analyticsCollect — the closed body shape and its cleaning;
 *   handler   lib/analyticsIngest — environment, size, origin, bots, consent,
 *             identity and rate limit, with the database faked;
 *   browser   lib/analyticsClient against a fake window/document/navigator;
 *   database  migration 0068 on a throwaway Postgres (embedded-postgres),
 *             through the real roles and grants. Without it the run exits 2.
 *
 * Nothing here reads .env.local or touches production.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_BODY_BYTES,
  REDACTED_TERM,
  collectionEnabled,
  deviceFor,
  geoFor,
  hasAnalyticsConsent,
  isBot,
  normalizePath,
  normalizeSearchTerm,
  parseBatch,
  rateKey,
  sourceFor,
  visitorIdFor,
  type CleanEvent,
} from "../lib/analyticsCollect";
import { handleEvents, type EventsDeps, type IngestContext } from "../lib/analyticsIngest";
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

// ── Rules ────────────────────────────────────
console.log("\nrules: the body is a closed shape");
const ok = (events: unknown[]) => parseBatch({ events });
t("1. an anonymous page view is accepted", ok([{ type: "page_view", path: "/in/shop" }]).ok);
t("3. a body carrying user_id is refused", !ok([{ type: "page_view", path: "/in", user_id: P }]).ok);
t("3. a top-level user_id is refused", !parseBatch({ events: [{ type: "page_view", path: "/in" }], user_id: P }).ok);
t("3. traffic / occurred_at cannot be claimed", !ok([{ type: "page_view", path: "/in", traffic: "customer" }]).ok && !ok([{ type: "page_view", path: "/in", occurred_at: "2020-01-01" }]).ok);
t("4. purchase from a browser is refused", !ok([{ type: "purchase", path: "/in" }]).ok);
t("4. wishlist_add from a browser is refused", !ok([{ type: "wishlist_add", path: "/in", product_id: P }]).ok);
t("4. an unknown type is refused", !ok([{ type: "scroll", path: "/in" }]).ok);
t("6. nested metadata is refused", !ok([{ type: "page_view", path: "/in", utm_source: { a: 1 } }]).ok);
t("6. a non-UUID product is refused", !ok([{ type: "product_view", path: "/in", product_id: "1 or 1=1" }]).ok);
t("6. product_view without a product is refused", !ok([{ type: "product_view", path: "/in" }]).ok);
t("6. cart_add without quantity is refused", !ok([{ type: "cart_add", path: "/in", product_id: P }]).ok);
t("6. quantity 100 is refused", !ok([{ type: "cart_add", path: "/in", product_id: P, quantity: 100 }]).ok);
t("6. a full URL as path is refused", !ok([{ type: "page_view", path: "https://evil.example/x" }]).ok && !ok([{ type: "page_view", path: "//evil.example" }]).ok);
t("6. 21 events is refused", !ok(Array.from({ length: 21 }, () => ({ type: "page_view", path: "/in" }))).ok);
t("6. an empty batch is refused", !ok([]).ok);
t("path drops the query string and fragment", normalizePath("/in/search?q=my@email.com#x") === "/in/search");
const entry = ok([{ type: "page_view", path: "/in", is_entry: true, referrer_host: "l.instagram.com", utm_campaign: "Onam Edit" }]);
t("entry page view carries source from the referrer host", entry.ok && entry.events[0].source === "instagram" && entry.events[0].utm_campaign === "onam_edit");
const later = ok([{ type: "product_view", path: "/in/x", product_id: P, is_entry: true, referrer_host: "google.com", utm_source: "x" }]);
t("attribution is dropped from anything but an entry page view", later.ok && later.events[0].source === null && later.events[0].referrer_host === null && !later.events[0].is_entry);

console.log("\nrules: sources, searches, devices, geography");
t("35. no referrer and no UTM is direct", sourceFor(null, null) === "direct");
t("35. an unrecognised host stays other, not a guess", sourceFor("someblog.example", null) === "other");
t("google.co.in is google", sourceFor("google.co.in", null) === "google");
t("a UTM source wins over the referrer", sourceFor("google.com", "newsletter") === "newsletter");
t("12. a search term is lower-cased and bounded", normalizeSearchTerm("  Kasavu   SAREE ") === "kasavu saree" && normalizeSearchTerm("x".repeat(300))!.length === 64);
t("20. an email typed into search is redacted", normalizeSearchTerm("asha@example.com") === REDACTED_TERM);
t("20. a phone number typed into search is redacted", normalizeSearchTerm("call 98470 12345") === REDACTED_TERM);
t("20. an order-like number is redacted", normalizeSearchTerm("order 123456") === REDACTED_TERM);
t("a saree with a size number is kept", normalizeSearchTerm("ring size 6") === "ring size 6");
t("36. iPhone is mobile, Mac is desktop, Android tablet is tablet",
  deviceFor(UA_PHONE) === "mobile" && deviceFor(UA_DESKTOP) === "desktop" && deviceFor(UA_TABLET) === "tablet");
t("Lighthouse, curl and an empty UA are bots", isBot(UA_LIGHTHOUSE) && isBot("curl/8.4.0") && isBot(null) && !isBot(UA_PHONE));
const h = (o: Record<string, string>) => new Headers(o);
const g = geoFor(h({ "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "KL", "x-vercel-ip-city": "Kochi" }));
t("37. country and region read; city ignored", g.country_code === "IN" && g.region === "KL" && !("city" in g));
t("22. no geo headers → null, not a guess", geoFor(h({})).country_code === null && geoFor(h({})).region === null);
t("22. malformed geo → null", geoFor(h({ "x-vercel-ip-country": "India", "x-vercel-ip-country-region": "Kerala" })).country_code === null);
t("21. the rate key is an HMAC that rotates daily",
  /^[0-9a-f]{64}$/.test(rateKey("1.2.3.4", "s")) &&
  rateKey("1.2.3.4", "s", new Date("2026-10-11T10:00Z")) !== rateKey("1.2.3.4", "s", new Date("2026-10-12T10:00Z")) &&
  rateKey("1.2.3.4", "s") !== rateKey("1.2.3.4", "other-secret") && !rateKey("1.2.3.4", "s").includes("1.2.3.4"));

console.log("\nrules: environments and consent");
t("10. off unless the switch is on", !collectionEnabled({ VERCEL_ENV: "production" }));
t("10. a preview never writes", !collectionEnabled({ NEXT_PUBLIC_ANALYTICS_ENABLED: "1", VERCEL_ENV: "preview" }));
t("10. local never writes", !collectionEnabled({ NEXT_PUBLIC_ANALYTICS_ENABLED: "1" }));
t("10. production with the switch on writes", collectionEnabled({ NEXT_PUBLIC_ANALYTICS_ENABLED: "1", VERCEL_ENV: "production" }));
t("10. a deliberate non-prod test can opt in", collectionEnabled({ NEXT_PUBLIC_ANALYTICS_ENABLED: "1", ANALYTICS_ALLOW_NONPROD: "1" }));
t("no consent cookie → no consent", !hasAnalyticsConsent(undefined) && !hasAnalyticsConsent("necessary"));
t("explicit analytics consent", hasAnalyticsConsent("necessary,analytics") && hasAnalyticsConsent(encodeURIComponent("necessary|analytics")));
t("a visitor id is ignored without consent", visitorIdFor(undefined, P) === null && visitorIdFor("analytics", P) === P);
t("a malformed visitor id is ignored", visitorIdFor("analytics", "abc") === null);

// ── Handler ──────────────────────────────────
(async () => {
  console.log("\nhandler: POST /api/events with the database faked");
  type Call = { key: string; context: IngestContext; events: CleanEvent[] };
  const calls: Call[] = [];
  let userAsked = 0;
  let limited = false;
  let broken = false;
  const deps = (env: Record<string, string> = { NEXT_PUBLIC_ANALYTICS_ENABLED: "1", VERCEL_ENV: "production" }): EventsDeps => ({
    env,
    secret: "test-secret",
    getUserId: async () => {
      userAsked++;
      return P;
    },
    ingest: async (key, context, events) => {
      if (broken) throw new Error("db down");
      calls.push({ key, context, events });
      return { accepted: events.length, duplicates: 0, skipped: 0, limited };
    },
  });
  const req = (body: unknown, o: { ua?: string; cookies?: Record<string, string>; origin?: string; method?: string; auth?: boolean; headers?: Record<string, string> } = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const headers = new Headers({
      "user-agent": o.ua ?? UA_PHONE,
      "content-length": String(text.length),
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      "x-vercel-ip-country": "IN",
      "x-vercel-ip-country-region": "KL",
      ...(o.origin ? { origin: o.origin } : {}),
      ...(o.headers ?? {}),
    });
    return {
      method: o.method ?? "POST",
      url: "https://www.thewovenne.com/api/events",
      headers,
      cookie: (n: string) => o.cookies?.[n],
      hasAuthCookie: o.auth ?? false,
      text: async () => text,
    };
  };
  const pv = { events: [{ type: "page_view", path: "/in" }] };

  let r = await handleEvents(req(pv), deps({ NEXT_PUBLIC_ANALYTICS_ENABLED: "1", VERCEL_ENV: "preview" }));
  t("10. preview → 204 and nothing stored", r.status === 204 && calls.length === 0);
  r = await handleEvents(req(pv), deps({ VERCEL_ENV: "production" }));
  t("10. switched off → 204 and nothing stored", r.status === 204 && calls.length === 0);
  r = await handleEvents(req(pv, { method: "GET" }), deps());
  t("GET → 405", r.status === 405);

  r = await handleEvents(req(pv, { origin: "https://www.thewovenne.com" }), deps());
  const c1 = calls.at(-1);
  t("1. anonymous page view stored", r.status === 204 && calls.length === 1);
  t("1. no visitor, no user, customer traffic", c1?.context.visitor_id === null && c1?.context.user_id === null && c1?.context.traffic === "customer");
  t("device, country and region derived server-side", c1?.context.device === "mobile" && c1?.context.country_code === "IN" && c1?.context.region === "KL");
  t("21. the raw IP never leaves the handler", !JSON.stringify(c1).includes("203.0.113.9") && !JSON.stringify(c1).includes(UA_PHONE));
  t("19. no auth cookie value is passed on", !JSON.stringify(c1).includes("sb-"));

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
  const before = calls.length;
  r = await handleEvents(req({ events: [{ type: "page_view", path: "/in", user_id: "00000000-0000-0000-0000-000000000001" }] }), deps());
  t("3. spoofed user id → 400, nothing stored", r.status === 400 && calls.length === before);
  r = await handleEvents(req({ events: [{ type: "purchase", path: "/in" }] }), deps());
  t("4/18. browser purchase → 400", r.status === 400 && calls.length === before);
  r = await handleEvents(req(pv, { ua: UA_LIGHTHOUSE }), deps());
  t("Lighthouse → 204, nothing stored", r.status === 204 && calls.length === before);

  userAsked = 0;
  r = await handleEvents(req(pv, { auth: true }), deps());
  t("2. signed in WITHOUT consent → no user id, Auth not even asked", calls.at(-1)?.context.user_id === null && userAsked === 0);
  r = await handleEvents(req(pv, { auth: true, cookies: { wv_consent: "analytics", wv_vid: P } }), deps());
  t("2. signed in WITH consent → user id from the validated session", calls.at(-1)?.context.user_id === P && userAsked === 1);
  t("32. consent → visitor id passed through", calls.at(-1)?.context.visitor_id === P);
  r = await handleEvents(req(pv, { cookies: { wv_vid: P } }), deps());
  t("a visitor cookie without consent is ignored", calls.at(-1)?.context.visitor_id === null);
  r = await handleEvents(req(pv, { cookies: { wv_internal: "1" } }), deps());
  t("9. a staff browser is internal traffic", calls.at(-1)?.context.traffic === "internal");

  limited = true;
  r = await handleEvents(req(pv), deps());
  t("7. rate limited → 429", r.status === 429);
  limited = false;
  broken = true;
  r = await handleEvents(req(pv), deps());
  t("database refusal → 503, not a crash", r.status === 503);
  broken = false;

  // ── Browser ───────────────────────────────────
  console.log("\nbrowser: lib/analyticsClient against a fake page");
  const beacons: string[] = [];
  const jar = new Map<string, string>();
  const listeners: Record<string, Array<() => void>> = {};
  const loc = { hostname: "www.thewovenne.com", pathname: "/in", search: "?utm_source=Instagram&utm_campaign=onam&email=a@b.c" };
  const fakeDoc = {
    referrer: "https://l.instagram.com/?u=https%3A%2F%2Fwww.thewovenne.com%2Fin&e=secret",
    visibilityState: "visible",
    addEventListener: (n: string, f: () => void) => (listeners[n] ??= []).push(f),
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(v: string) {
      const [pair, ...attrs] = v.split("; ");
      const [k, val] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.includes("Max-Age=0")) jar.delete(k);
      else jar.set(k, val);
    },
  };
  const nav = { webdriver: false, sendBeacon: (_u: string, b: Blob) => { void b.text().then((x) => beacons.push(x)); return true; } };
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
  t("the entry carries the referrer HOST and UTMs only", ev[0]?.is_entry === true && ev[0]?.referrer_host === "l.instagram.com" && ev[0]?.utm_source === "Instagram");
  t("20. no query string, other params or referrer URL leave the page", !beacons.join("").includes("a@b.c") && !beacons.join("").includes("secret") && ev[0]?.path === "/in");
  t("the batch body passes the server's rules", beacons.every((b) => parseBatch(JSON.parse(b)).ok));
  t("no visitor id without consent", !jar.has("wv_vid"));

  beacons.length = 0;
  loc.pathname = "/in/women/sarees/black-line-border";
  client.trackPageView();
  client.trackOncePerPage(`product:${P}`, "product_view", { product_id: P });
  client.trackOncePerPage(`product:${P}`, "product_view", { product_id: P }); // hydration / strict mode
  await flushNow();
  ev = sent();
  t("11. product view once per page view, despite re-runs", ev.filter((e) => e.type === "product_view").length === 1);
  t("a later page view is not an entry and carries no attribution", ev.find((e) => e.type === "page_view")?.is_entry === undefined && !("referrer_host" in (ev.find((e) => e.type === "page_view") ?? {})));

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
  await flushNow();
  ev = sent();
  t("15/16. cart add and remove sent; quantity clamped; a bad id dropped",
    ev.length === 2 && ev[0].type === "cart_add" && ev[0].quantity === 99 && ev[1].type === "cart_remove");
  t("8. every event carries its own id (retries dedupe)", new Set(ev.map((e) => e.client_event_id)).size === ev.length);

  beacons.length = 0;
  for (let i = 0; i < 25; i++) client.track("whatsapp_click");
  await flushNow();
  t("batched: 25 events leave in ≤ 3 requests of ≤ 20", beacons.length <= 3 && beacons.every((b) => JSON.parse(b).events.length <= 20) && sent().length === 25);

  beacons.length = 0;
  jar.set("wv_consent", "necessary,analytics");
  client.track("whatsapp_click");
  await flushNow();
  t("32. with consent a random visitor id is created", /^[0-9a-f-]{36}$/.test(jar.get("wv_vid") ?? ""));
  t("the visitor id is never in the body", !beacons.join("").includes(jar.get("wv_vid") ?? "@@"));
  jar.set("wv_consent", "necessary");
  client.track("whatsapp_click");
  await flushNow();
  t("withdrawn consent deletes the visitor id", !jar.has("wv_vid"));

  beacons.length = 0;
  nav.webdriver = true;
  client.track("whatsapp_click");
  await flushNow();
  t("an automated browser sends nothing", beacons.length === 0);
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

  // ── Source wiring ─────────────────────────────
  console.log("\nwiring");
  const read = (f: string) => fs.readFileSync(f, "utf8");
  const clientSrc = read("lib/analyticsClient.ts");
  t("performance: the browser client imports nothing but cookie names", [...clientSrc.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]).join() === "./analyticsCookies");
  t("performance: no Supabase, no SDK in the tracker or beacon",
    !/supabase|@vercel|gtag|googletagmanager/.test(read("components/analytics/AnalyticsTracker.tsx") + read("components/analytics/AnalyticsBeacon.tsx") + clientSrc));
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
  t("9. middleware marks a verified admin's browser internal", /INTERNAL_COOKIE, "1"/.test(read("middleware.ts")));
  t("the collector route uses the service role only server-side", read("app/api/events/route.ts").includes("createServiceClient") && !clientSrc.includes("SERVICE_ROLE"));
  const migration = read("supabase/migrations/0068_analytics_foundation.sql");
  t("23. no gender, IP, UA, city or coordinates column", !/^\s+(gender|inferred_gender|predicted_gender|ip|ip_address|user_agent|city|latitude|longitude)\s/im.test(migration));

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
  console.log("\ndatabase: migration 0068 through the real roles");
  await asRoot(c);
  const cat = (await c.query("insert into categories (name, slug) values ('Test sarees', 'test-analytics-sarees') returning id")).rows[0].id as string;
  const prod = (await c.query("insert into products (name, slug, price_inr, category_id) values ('Kasavu', 'test-analytics-kasavu', 1000, $1) returning id", [cat])).rows[0].id as string;
  const prod2 = (await c.query("insert into products (name, slug, price_inr) values ('Dhoti', 'test-analytics-dhoti', 900) returning id")).rows[0].id as string;
  const admin = await makeAdmin(c, "staff@thewovenne.test");
  const cust = (await c.query("insert into auth.users (email) values ('asha@example.test') returning id")).rows[0].id as string;
  await c.query("insert into profiles (id, email) values ($1, 'asha@example.test') on conflict do nothing", [cust]);

  const KEY = "a".repeat(64);
  const ctx = (o: Record<string, unknown> = {}) => JSON.stringify({ visitor_id: null, user_id: null, device: "mobile", country_code: "IN", region: "KL", traffic: "customer", ...o });
  const ingest = async (events: unknown[], o: Record<string, unknown> = {}, key = KEY) => {
    await asService(c);
    const r = (await c.query("select analytics_ingest($1, $2::jsonb, $3::jsonb) r", [key, ctx(o), JSON.stringify(events)])).rows[0].r;
    await asRoot(c);
    return r as { accepted: number; duplicates: number; skipped: number; limited: boolean };
  };
  const count = async (where = "true", args: unknown[] = []) => {
    await asRoot(c);
    return Number((await c.query(`select count(*) n from analytics_events where ${where}`, args)).rows[0].n);
  };

  // Ingest
  let r = await ingest([{ type: "page_view", path: "/in", is_entry: true, source: "instagram", referrer_host: "l.instagram.com" }]);
  t("1. anonymous page view stored", r.accepted === 1 && (await count("event_type = 'page_view' and session_id is null and visitor_id is null and user_id is null")) === 1);
  t("1. entry attribution kept", (await count("source = 'instagram' and is_entry")) === 1);
  r = await ingest([{ type: "page_view", path: "/in/x", source: "google", utm_source: "x" }]);
  t("attribution off an entry page is dropped by the database too", (await count("path = '/in/x' and source is null and utm_source is null")) === 1);
  r = await ingest([{ type: "product_view", path: "/in/p", product_id: prod }]);
  t("11. product view stored with the category taken from the product", (await count("event_type = 'product_view' and product_id = $1 and category_id = $2", [prod, cat])) === 1);
  r = await ingest([{ type: "product_view", path: "/in/p", product_id: "00000000-0000-4000-8000-000000000000" }]);
  t("a product that does not exist is skipped, not stored", r.skipped === 1 && r.accepted === 0);
  r = await ingest([{ type: "purchase", path: "/in" }, { type: "wishlist_add", path: "/in", product_id: prod }]);
  t("4/18. purchase and wishlist cannot come through ingest", r.skipped === 2 && (await count("event_type in ('purchase','wishlist_add')")) === 0);
  r = await ingest([{ type: "search", path: "/in/search", search_term: "kasavu", result_count: 3 }]);
  t("12. search stored with term and result count", (await count("event_type = 'search' and search_term = 'kasavu' and result_count = 3")) === 1);
  r = await ingest([{ type: "cart_add", path: "/in/p", product_id: prod, quantity: 2 }, { type: "cart_remove", path: "/in/cart", product_id: prod, quantity: 1 }]);
  t("15/16. cart add and remove stored with quantity", (await count("event_type = 'cart_add' and quantity = 2")) === 1 && (await count("event_type = 'cart_remove' and quantity = 1")) === 1);
  r = await ingest([{ type: "checkout_start", path: "/in/checkout" }, { type: "whatsapp_click", path: "/in" }]);
  t("17. checkout start and WhatsApp click stored", (await count("event_type in ('checkout_start','whatsapp_click')")) === 2);
  const EID = "11111111-1111-4111-8111-111111111111";
  await ingest([{ type: "page_view", path: "/in/d", client_event_id: EID }]);
  r = await ingest([{ type: "page_view", path: "/in/d", client_event_id: EID }]);
  t("8. a retried beacon is stored once", r.duplicates === 1 && (await count("client_event_id = $1", [EID])) === 1);
  t("6. 21 events in one call is refused", (await failure(() => ingest(Array.from({ length: 21 }, () => ({ type: "page_view", path: "/in" }))))).includes("at most 20"));
  t("6. a bad device value is refused by the table", (await failure(() => ingest([{ type: "page_view", path: "/in" }], { device: "fridge" }))).length > 0);
  t("6. an invalid rate key is refused", (await failure(() => ingest([{ type: "page_view", path: "/in" }], {}, "not-hex"))).includes("rate key"));

  // Rate limit
  const K2 = "b".repeat(64);
  let limitedAt = -1;
  for (let i = 0; i < 8; i++) {
    const x = await ingest(Array.from({ length: 20 }, () => ({ type: "page_view", path: "/in/r" })), {}, K2);
    if (x.limited && limitedAt < 0) limitedAt = i;
  }
  t("7. 120 events a minute per key, then refused", limitedAt === 6 && (await count("path = '/in/r'")) === 120);
  t("7. another key is unaffected", !(await ingest([{ type: "page_view", path: "/in" }], {}, "c".repeat(64))).limited);
  await c.query("update analytics_rate set window_start = now() - interval '2 minutes' where rate_key = $1", [K2]);
  t("7. the window resets after a minute", !(await ingest([{ type: "page_view", path: "/in/r" }], {}, K2)).limited);

  // Sessions and identity
  const V = "22222222-2222-4222-8222-222222222222";
  await ingest([{ type: "page_view", path: "/in", is_entry: true, source: "google", referrer_host: "google.com" }], { visitor_id: V });
  await ingest([{ type: "product_view", path: "/in/p", product_id: prod }], { visitor_id: V });
  let s = (await c.query("select id, source, landing_path, event_count, user_id from analytics_sessions where visitor_id = $1", [V])).rows;
  t("32. a consented visitor's events share one session", s.length === 1 && s[0].event_count === 2 && s[0].source === "google" && s[0].landing_path === "/in");
  t("32. events carry the session", (await count("visitor_id = $1 and session_id = $2", [V, s[0].id])) === 2);
  await ingest([{ type: "page_view", path: "/in/a" }], { visitor_id: V, user_id: cust });
  s = (await c.query("select user_id from analytics_sessions where visitor_id = $1", [V])).rows;
  t("2. signing in mid-session attaches the user to the session", s[0].user_id === cust);
  t("2. earlier anonymous events are NOT rewritten with the identity", (await count("visitor_id = $1 and user_id is null", [V])) === 2 && (await count("visitor_id = $1 and user_id = $2", [V, cust])) === 1);
  await c.query("update analytics_sessions set last_seen_at = now() - interval '31 minutes' where visitor_id = $1", [V]);
  await ingest([{ type: "page_view", path: "/in" }], { visitor_id: V });
  t("32. 30 minutes idle starts a new session", Number((await c.query("select count(*) n from analytics_sessions where visitor_id = $1", [V])).rows[0].n) === 2);
  await ingest([{ type: "page_view", path: "/in/z" }], { user_id: "33333333-3333-4333-8333-333333333333" });
  t("a user id that does not exist is dropped", (await count("path = '/in/z' and user_id is null")) === 1);
  await ingest([{ type: "page_view", path: "/in/staff" }], { user_id: admin, traffic: "customer" });
  t("9. a staff user is internal whatever the context says", (await count("path = '/in/staff' and traffic = 'internal'")) === 1);

  // Roles
  console.log("\ndatabase: who can read and write");
  const deniedAll = async (label: string) => {
    for (const tbl of ["analytics_events", "analytics_sessions", "analytics_rate"]) {
      const sel = await failure(() => c.query(`select 1 from ${tbl} limit 1`));
      const ins = await failure(() => c.query(`insert into ${tbl} default values`));
      if (!sel.includes("permission denied") || !ins.includes("permission denied")) {
        t(`${label}: no access to ${tbl}`, false, `${sel} / ${ins}`);
        return;
      }
    }
    const ing = await failure(() => c.query("select analytics_ingest($1, '{}'::jsonb, '[]'::jsonb)", [KEY]));
    t(`${label}: cannot read or write raw analytics, cannot call ingest`, ing.includes("permission denied"));
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
  t("27. a verified admin can read diagnostics", Array.isArray(d.by_type) && d.by_type.length > 0);
  t("diagnostics carry counts only — no ids", !JSON.stringify(d).match(/[0-9a-f]{8}-[0-9a-f]{4}-/));
  t("27. a verified admin still cannot read the raw table", (await failure(() => c.query("select 1 from analytics_events"))).includes("permission denied"));
  t("diagnostics refuse an absurd window", (await failure(() => diag("now()", "now() - interval '1 day'"))).includes("invalid window"));
  // Keep the admin's token (claims) but end its session, as sign-out does.
  const claims = (await c.query("select current_setting('request.jwt.claims') c")).rows[0].c as string;
  await c.query("reset role");
  await c.query("delete from auth.sessions where user_id = $1", [admin]);
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [admin, claims]);
  const revoked = await failure(() => diag());
  t("28/29. the same token after its session ended (0067) cannot read diagnostics", revoked.includes("Only admins"), revoked);
  await asRoot(c);

  // Wishlist trigger
  console.log("\ndatabase: wishlist and purchase come from the authoritative rows");
  await asUser(c, cust, "aal1");
  await c.query("insert into wishlists (user_id, product_id) values ($1, $2)", [cust, prod]);
  await c.query("delete from wishlists where user_id = $1 and product_id = $2", [cust, prod]);
  await asRoot(c);
  t("13. a customer's wishlist add is recorded", (await count("event_type = 'wishlist_add' and product_id = $1 and traffic = 'customer'", [prod])) === 1);
  t("14. a customer's wishlist remove is recorded", (await count("event_type = 'wishlist_remove' and product_id = $1", [prod])) === 1);
  t("13. no user id is copied into the event", (await count("event_type like 'wishlist%' and user_id is not null")) === 0);
  await asUser(c, admin, "aal2");
  await c.query("insert into wishlists (user_id, product_id) values ($1, $2)", [admin, prod2]);
  await asRoot(c);
  t("9. staff wishlist activity is internal", (await count("event_type = 'wishlist_add' and product_id = $1 and traffic = 'internal'", [prod2])) === 1);
  await asUser(c, cust, "aal1");
  await c.query("insert into wishlists (user_id, product_id) values ($1, $2)", [cust, prod2]);
  await asRoot(c);
  const removesBefore = await count("event_type = 'wishlist_remove'");
  await c.query("delete from products where id = $1", [prod2]);
  t("a product deletion cascading through wishlists is not counted as removes", (await count("event_type = 'wishlist_remove'")) === removesBefore);

  // Purchase trigger
  const order = async (email: string, method: string | null, status = "pending") =>
    (await c.query("insert into orders (customer_email, total_inr, payment_status, payment_method, items) values ($1, 1000, $2, $3, '[]') returning id", [email, status, method])).rows[0].id as string;
  const o1 = await order("asha@example.test", "razorpay");
  t("18. a pending order is not a purchase", (await count("event_type = 'purchase' and order_id = $1", [o1])) === 0);
  await c.query("update orders set payment_status = 'paid' where id = $1", [o1]);
  t("18. the order becoming paid is one purchase", (await count("event_type = 'purchase' and order_id = $1 and traffic = 'customer'", [o1])) === 1);
  await c.query("update orders set payment_status = 'paid' where id = $1", [o1]);
  await c.query("update orders set payment_status = 'pending' where id = $1", [o1]);
  await c.query("update orders set payment_status = 'paid' where id = $1", [o1]);
  t("18. a replayed settlement is still one purchase", (await count("event_type = 'purchase' and order_id = $1", [o1])) === 1);
  const o2 = await order("walk-in@example.test", "cash", "paid");
  t("an in-person sale is not a web purchase", (await count("order_id = $1", [o2])) === 0);
  const o3 = await order("STAFF@thewovenne.test", "razorpay", "paid");
  t("9. a purchase by a staff email is internal", (await count("order_id = $1 and traffic = 'internal'", [o3])) === 1);
  await c.query("alter table analytics_events add constraint test_break check (event_type <> 'purchase') not valid");
  const o4 = await order("asha@example.test", "razorpay");
  const broke = await failure(() => c.query("update orders set payment_status = 'paid' where id = $1", [o4]));
  t("a failing analytics write never blocks marking an order paid",
    broke === "" && (await c.query("select payment_status from orders where id = $1", [o4])).rows[0].payment_status === "paid");
  await c.query("alter table analytics_events drop constraint test_break");
  await asAdmin(c, admin);
  const flaggedBefore = (await diag()).rows[0].d.purchases_no_longer_paid as number;
  await asRoot(c);
  await c.query("update orders set payment_status = 'refunded' where id = $1", [o1]);
  await asAdmin(c, admin);
  const flaggedAfter = (await diag()).rows[0].d.purchases_no_longer_paid as number;
  t("diagnostics flag a purchase whose order is no longer paid", flaggedAfter === flaggedBefore + 1, `${flaggedBefore} → ${flaggedAfter}`);
  await asRoot(c);

  // Retention and schema
  console.log("\ndatabase: retention and schema");
  await c.query("update analytics_events set occurred_at = now() - interval '200 days' where path = '/in/r'");
  await asService(c);
  t("purge refuses to keep less than 30 days", (await failure(() => c.query("select analytics_purge(7)"))).includes("at least 30"));
  const purged = (await c.query("select analytics_purge(180) p")).rows[0].p;
  await asRoot(c);
  t("purge removes raw events past the window", purged.events >= 121 && (await count("path = '/in/r'")) === 0);
  const cols = (await c.query("select column_name from information_schema.columns where table_schema = 'public' and table_name in ('analytics_events','analytics_sessions') order by 1")).rows.map((x) => x.column_name as string);
  t("19/20/21/23. no token, password, IP, UA, city, coordinates, email or gender column",
    !cols.some((x) => /token|password|^ip|user_agent|city|latitude|longitude|email|gender|form/.test(x)), cols.join(","));
  t("22. country and region are nullable", (await c.query("select bool_and(is_nullable = 'YES') n from information_schema.columns where table_name = 'analytics_events' and column_name in ('country_code','region')")).rows[0].n === true);
  t("29. diagnostics gate is can_read_analytics → hardened is_admin()",
    /can_read_analytics\(\)/.test((await c.query("select prosrc from pg_proc where proname = 'analytics_diagnostics'")).rows[0].prosrc) &&
    /is_admin\(\)/.test((await c.query("select prosrc from pg_proc where proname = 'can_read_analytics'")).rows[0].prosrc));
}

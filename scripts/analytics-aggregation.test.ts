/**
 * Analytics 1B: daily aggregates, reconciliation, retention and the nightly
 * job (migrations 0069 + 0070) on a throwaway Postgres, through the real
 * roles and grants. Design: docs/analytics.md §9.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/analytics-aggregation.test.ts
 *
 * Days are relative to "today" in Asia/Kolkata, so the rules that depend on
 * the clock (a day must be over before it is rolled up; the 35-day rebuild
 * window; 180-day retention) are tested as they will run. Raw events are
 * inserted directly with chosen times — the collector is 0068's and is tested
 * in analytics-foundation.test.ts; one block below goes through
 * analytics_ingest / analytics_record_purchase end to end.
 *
 * Without the harness the run exits 2. Nothing here touches production.
 */
import fs from "node:fs";
import { asAdmin, asRoot, asService, asStaffPasswordOnly, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

const read = (p: string) => fs.readFileSync(p, "utf8");

(async () => {
  console.log("\nsource");
  const m69 = read("supabase/migrations/0069_analytics_daily.sql");
  const m70 = read("supabase/migrations/0070_analytics_schedule.sql");
  t("0070 schedules 20:30 UTC (02:00 IST) and nothing else", (m70.match(/cron\.schedule\(/g) ?? []).length === 1 &&
    m70.includes("cron.schedule('wovenne-analytics-nightly', '30 20 * * *', 'select public.analytics_nightly()')"));
  t("0070 refuses a cron clock that is not UTC", m70.includes("cron.timezone") && m70.includes("MIGRATION_0070_SELF_CHECK_FAILED"));
  t("0070 is skipped, not failed, where pg_cron is not offered", m70.includes("pg_available_extensions") && m70.includes("raise notice"));
  t("no aggregate column for visitors, sessions, revenue, orders or location below region",
    !/^\s+(visitors?|sessions?|unique_visitors|revenue\w*|order_id|city|latitude|longitude|ip\w*|user_id|email)\s/im.test(m69.split("-- ── Coverage")[0]));
  const ops = read("scripts/analytics-rollup.mjs");
  t("the ops script reads in a READ ONLY transaction unless rolling up", ops.includes('writes ? "begin" : "begin read only"') && ops.includes('const writes = action === "rollup" || action === "nightly"'));
  t("the ops script calls only the 0069 functions, never DML on analytics tables",
    !/\b(insert into|update|delete from)\s+public\.analytics/i.test(ops) && ops.includes("analytics_rollup_day(") && ops.includes("analytics_nightly()") && ops.includes("analytics_reconcile("));
  t("no Vercel cron, no new public endpoint for the job", !fs.existsSync("vercel.json") && !fs.existsSync("app/api/cron"));

  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (DB SKIPPED)\n`);
    process.exit(fail ? 1 : 2);
  }
  let c: Client | null = null;
  try {
    await engine.database("agg");
    c = await engine.connect("agg");
    await database(c);
  } catch (e) {
    t("database half ran", false, (e as Error).stack ?? String(e));
  } finally {
    await c?.end();
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

type Row = Record<string, unknown>;

async function database(c: Client) {
  await asRoot(c);
  const q = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows as Row[];
  const one = async (sql: string, args: unknown[] = []) => (await q(sql, args))[0];
  const today = (await one("select analytics_day_of(now())::text d")).d as string;
  const day = async (offset: number) => (await one("select ($1::date + $2::int)::text d", [today, offset])).d as string;

  // ── Fixtures ──
  const cat = (await one("insert into categories (name, slug) values ('Sarees', 'agg-sarees') returning id")).id as string;
  const cat2 = (await one("insert into categories (name, slug) values ('Mundu', 'agg-mundu') returning id")).id as string;
  const product = async (name: string, slug: string, category = cat) =>
    (await one("insert into products (name, slug, price_inr, category_id) values ($1, $2, 1000, $3) returning id", [name, slug, category])).id as string;
  const P1 = await product("Kasavu Saree", "agg-kasavu");
  const P2 = await product("Set Mundu", "agg-mundu-1", cat2);
  const admin = await makeAdmin(c, "staff@thewovenne.test");
  const cust = (await one("insert into auth.users (email) values ('asha@example.test') returning id")).id as string;
  await q("insert into profiles (id, email) values ($1, 'asha@example.test') on conflict do nothing", [cust]);
  const order = async (items: unknown[], status = "paid") =>
    (await one("insert into orders (customer_email, total_inr, payment_status, payment_method, items) values ('asha@example.test', 3000, $1, 'razorpay', $2::jsonb) returning id",
      [status, JSON.stringify(items)])).id as string;

  // An event at an exact IST wall-clock time on a day.
  type Ev = {
    type: string; at?: string; product?: string | null; category?: string | null; entry?: boolean; source?: string | null; medium?: string | null;
    host?: string | null; campaign?: string | null; device?: string | null; country?: string | null; region?: string | null;
    term?: string | null; results?: number | null; qty?: number | null; traffic?: string; order?: string | null;
  };
  const ev = async (d: string, e: Ev) => {
    await asRoot(c);
    await q(`insert into analytics_events (event_type, occurred_at, product_id, category_id, path, is_entry, source, medium, referrer_host,
               utm_campaign, device, country_code, region, search_term, result_count, quantity, traffic, order_id)
             values ($1, ($2::date + $3::time)::timestamp at time zone 'Asia/Kolkata', $4, $5, '/in/x', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [e.type, d, e.at ?? "12:00", e.product ?? null, e.category ?? (e.product === P1 ? cat : e.product === P2 ? cat2 : null), e.entry ?? false,
       e.source ?? null, e.medium ?? null, e.host ?? null, e.campaign ?? null, e.device === undefined ? "mobile" : e.device,
       e.country === undefined ? "IN" : e.country, e.region === undefined ? "KL" : e.region,
       e.term ?? null, e.results ?? null, e.qty ?? null, e.traffic ?? "customer", e.order ?? null]);
  };
  const rollup = async (d: string) => (await one("select analytics_rollup_day($1::date) r", [d])).r as Row;
  const agg = async (d: string, grain: string, where = "true", args: unknown[] = []) =>
    q(`select * from analytics_daily where day = $1::date and grain = $2 and ${where} order by event_type`, [d, grain, ...args]);
  const total = async (d: string, type: string) => Number((await agg(d, "total", "event_type = $3", [type]))[0]?.events ?? 0);
  const snapshot = async (d: string) =>
    JSON.stringify(await q("select grain, event_type, product_id, category_id, product_name, country_code, region, device, source, medium, campaign, referrer_host, search_term, zero_results, events, units, entries from analytics_daily where day = $1::date order by 1,2,3,4,5,6,7,8,9,10,11,12,13,14", [d]));

  // ── Day D: a realistic mix ──
  const D = await day(-10);
  const O1 = await order([{ id: P1, name: "Kasavu Saree", quantity: 1, price_inr: 1000 }, { id: P2, name: "Set Mundu", quantity: 2, price_inr: 1000 }]);
  const O2 = await order([{ id: P1, name: "Kasavu Saree", quantity: 1, price_inr: 1000 }]);
  const O3 = await order([{ id: P2, name: "Set Mundu", quantity: 1, price_inr: 1000 }]);
  const cust1: Ev[] = [
    { type: "page_view", entry: true, source: "instagram", medium: "social", host: "l.instagram.com", campaign: "onam", device: "mobile" },
    { type: "page_view", entry: true, source: "direct", medium: "none", device: "desktop", country: "GB", region: "ENG" },
    { type: "page_view", device: null, country: null, region: null }, // a reload: unknown source, unknown device, no geo
    { type: "product_view", product: P1, source: "instagram", medium: "social", host: "l.instagram.com", campaign: "onam" },
    { type: "product_view", product: P1, source: "chatgpt", medium: "referral", host: "chatgpt.com" },
    { type: "product_view", product: P2, device: "tablet" },
    { type: "wishlist_add", product: P1 },
    { type: "wishlist_remove", product: P1 },
    { type: "cart_add", product: P1, qty: 2 },
    { type: "cart_add", product: P2, qty: 1 },
    { type: "cart_remove", product: P2, qty: 1 },
    { type: "checkout_start" },
    { type: "whatsapp_click" },
    { type: "search", term: "kasavu", results: 4 },
    { type: "search", term: "kasavu", results: 4 },
    { type: "search", term: "xyzzy", results: 0 },
    { type: "search", term: "(redacted)", results: 0 },
    { type: "purchase", order: O1, device: null, country: null, region: null },
  ];
  for (const e of cust1) await ev(D, e);
  for (const e of [{ type: "page_view" }, { type: "page_view" }, { type: "product_view", product: P1 }, { type: "purchase", order: O3, device: null, country: null, region: null }] as Ev[])
    await ev(D, { ...e, traffic: "internal" });
  for (const e of [{ type: "page_view" }, { type: "purchase", order: O2, device: null, country: null, region: null }] as Ev[])
    await ev(D, { ...e, traffic: "test" });

  console.log("\naggregation: one day");
  const r1 = await rollup(D);
  t("1. a finished day rolls up and records its raw counts by class",
    r1.customer_events === 18 && r1.internal_events === 4 && r1.test_events === 2 && Number(r1.aggregate_rows) > 0, JSON.stringify(r1));
  const types = Object.fromEntries((await agg(D, "total")).map((x) => [x.event_type, x.events]));
  t("2. every event type counted in the total grain",
    JSON.stringify(types) === JSON.stringify({ cart_add: 2, cart_remove: 1, checkout_start: 1, page_view: 3, product_view: 3, purchase: 1, search: 4, whatsapp_click: 1, wishlist_add: 1, wishlist_remove: 1 }),
    JSON.stringify(types));
  t("3/4/5. customer only: internal page views, internal + test purchases are not in any total",
    types.page_view === 3 && types.purchase === 1 && (await q("select sum(events) n from analytics_daily where day = $1::date and grain = 'total'", [D]))[0].n === "18");
  const pvTotal = (await agg(D, "total", "event_type = 'page_view'"))[0];
  t("landings: page views carry how many were the first page of a page load", pvTotal.entries === 2);
  const cartTotal = (await agg(D, "total", "event_type = 'cart_add'"))[0];
  t("cart adds carry units (2 + 1)", cartTotal.events === 2 && cartTotal.units === 3);
  const purTotal = (await agg(D, "total", "event_type = 'purchase'"))[0];
  t("purchase total: 1 order, 3 units sold (from the order's own lines)", purTotal.events === 1 && purTotal.units === 3);

  console.log("\naggregation: grains");
  const prod = await agg(D, "product");
  const pr = (type: string, id: string) => prod.find((x) => x.event_type === type && x.product_id === id);
  t("11. product views by product (P1: 2, P2: 1)", pr("product_view", P1)?.events === 2 && pr("product_view", P2)?.events === 1);
  t("11. wishlist adds and cart adds by product, with units", pr("wishlist_add", P1)?.events === 1 && pr("cart_add", P1)?.units === 2 && pr("cart_add", P2)?.units === 1);
  t("11. purchases by product: orders containing it and units sold", pr("purchase", P1)?.events === 1 && pr("purchase", P1)?.units === 1 && pr("purchase", P2)?.events === 1 && pr("purchase", P2)?.units === 2);
  t("11. product rows carry the category and name they had", pr("product_view", P2)?.category_id === cat2 && pr("product_view", P1)?.product_name === "Kasavu Saree");
  t("checkout_start has no product grain (a checkout is the whole bag)", !prod.some((x) => x.event_type === "checkout_start"));
  const loc = await agg(D, "location", "event_type = 'page_view'");
  const at = (cc: string | null, rg: string | null) => loc.find((x) => x.country_code === cc && x.region === rg)?.events;
  t("12/13. country and region: IN/KL 1, GB/ENG 1, unknown 1", at("IN", "KL") === 1 && at("GB", "ENG") === 1 && at(null, null) === 1 && loc.length === 3);
  t("purchases have no IP location, device or source rows (not mixed with delivery region)",
    (await q("select count(*) n from analytics_daily where day = $1::date and event_type = 'purchase' and grain in ('location','device','source')", [D]))[0].n === "0");
  const dev = await agg(D, "device", "event_type = 'page_view'");
  t("14. device: mobile 1, desktop 1, unknown (NULL) 1", dev.length === 3 && dev.some((x) => x.device === "mobile" && x.events === 1) && dev.some((x) => x.device === "desktop") && dev.some((x) => x.device === null));
  t("14. tablet counted for its product view", (await agg(D, "device", "event_type = 'product_view' and device = 'tablet'"))[0]?.events === 1);
  const src = await agg(D, "source", "event_type = 'product_view'");
  t("15/16/17. source, medium, campaign and referrer host kept together",
    src.some((x) => x.source === "instagram" && x.medium === "social" && x.campaign === "onam" && x.referrer_host === "l.instagram.com" && x.events === 1));
  t("an AI assistant is named only because its own host referred (chatgpt.com)", src.some((x) => x.source === "chatgpt" && x.referrer_host === "chatgpt.com"));
  const pvSrc = await agg(D, "source", "event_type = 'page_view'");
  t("18. unknown attribution stays unknown (NULL), distinct from direct",
    pvSrc.some((x) => x.source === null && x.medium === null && x.events === 1) && pvSrc.some((x) => x.source === "direct" && x.medium === "none" && x.events === 1));
  t("18. nothing is inferred: no row claims a source the raw rows did not have",
    (await q("select count(*) n from analytics_daily a where a.day = $1::date and a.grain = 'source' and a.source is not null and not exists (select 1 from analytics_events e where e.source = a.source)", [D]))[0].n === "0");
  const srch = await agg(D, "search");
  const term = (s: string) => srch.find((x) => x.search_term === s);
  t("19. search terms counted, with zero-result state", term("kasavu")?.events === 2 && term("kasavu")?.zero_results === false && term("xyzzy")?.zero_results === true);
  t("19. a redacted search stays redacted in the aggregate", term("(redacted)")?.events === 1 && !srch.some((x) => /@|\d{5,}/.test(String(x.search_term))));

  console.log("\naggregation: reruns, late events, empty days");
  const before = await snapshot(D);
  await rollup(D);
  await rollup(D);
  t("7. rolling the same day up twice more changes nothing (no double count)", (await snapshot(D)) === before);
  await ev(D, { type: "page_view", at: "23:59:59", source: "google", medium: "organic", host: "www.google.com" });
  t("8. a late event is not counted until the day is rebuilt…", (await total(D, "page_view")) === 3);
  await rollup(D);
  t("8. …and is counted after it (4)", (await total(D, "page_view")) === 4);
  const E = await day(-11);
  const rE = await rollup(E);
  t("22. an empty day rolls up to zero rows but is recorded as covered",
    rE.customer_events === 0 && rE.aggregate_rows === 0 && (await q("select 1 from analytics_daily_runs where day = $1::date", [E])).length === 1);
  t("a day that has not ended in IST cannot be rolled up", (await failure(() => rollup(today))).includes("has not finished"));

  console.log("\naggregation: IST day boundaries");
  const B = await day(-20);
  const B1 = await day(-19);
  await ev(B, { type: "page_view", at: "00:00:00" });          // first instant of B in IST (= B-1 18:30 UTC)
  await ev(B, { type: "page_view", at: "05:29:59" });          // B-1 23:59:59 UTC — still B in IST
  await ev(B, { type: "page_view", at: "05:30:00" });          // B 00:00 UTC
  await ev(B, { type: "page_view", at: "23:59:59.999" });      // last instant of B in IST (= B 18:29:59.999 UTC)
  await ev(B1, { type: "page_view", at: "00:00:00" });         // B 18:30 UTC — UTC still says B; IST says B+1
  await ev(B1, { type: "page_view", at: "01:30:00" });         // B 20:00 UTC
  await rollup(B);
  await rollup(B1);
  t("9. IST midnight to midnight: all four instants of B land on B", (await total(B, "page_view")) === 4);
  t("10. events on UTC day B after 18:30 UTC land on B+1, not B", (await total(B1, "page_view")) === 2);
  const utcB1 = (await one("select count(*) n from analytics_events where (occurred_at at time zone 'UTC')::date = $1::date", [B1])).n;
  t("10. (grouping by UTC date would have put none of B+1's 2 events on B+1)", utcB1 === "0", String(utcB1));
  const win = await one("select analytics_day_start($1::date) a, analytics_day_start($1::date + 1) b", [B]);
  t("a business day is exactly [d-1 18:30 UTC, d 18:30 UTC)",
    (win.a as Date).toISOString() === new Date(`${B}T00:00:00+05:30`).toISOString() && (win.b as Date).getTime() - (win.a as Date).getTime() === 86400000);

  console.log("\naggregation: purchases and test payments, end to end");
  const F = await day(-1);
  await q("update analytics_config set collecting = true where id");
  const OL = await order([{ id: P1, name: "Kasavu Saree", quantity: 1, price_inr: 1000 }]);
  const OT = await order([{ id: P1, name: "Kasavu Saree", quantity: 5, price_inr: 1000 }]);
  await asService(c);
  const rec = [
    (await one("select analytics_record_purchase($1, false) r", [OL])).r,
    (await one("select analytics_record_purchase($1, false) r", [OL])).r,
    (await one("select analytics_record_purchase($1, true) r", [OT])).r,
  ];
  await one("select analytics_ingest($1, $2::jsonb, $3::jsonb) r", ["e".repeat(64), JSON.stringify({ device: "mobile", country_code: "IN", region: "TN", traffic: "customer" }),
    JSON.stringify([{ type: "product_view", path: "/in/p", product_id: P1, source: "google", medium: "organic", referrer_host: "www.google.com" }])]);
  await asRoot(c);
  await q("update analytics_events set occurred_at = analytics_day_start($1::date) + interval '9 hours' where occurred_at > now() - interval '1 hour'", [F]);
  await rollup(F);
  t("20. settlement + webhook + replay: one purchase event, one purchase in the total", rec.join() === "recorded,duplicate,recorded" && (await total(F, "purchase")) === 1);
  t("21. a Razorpay test-mode purchase is not in the customer total (5 units excluded)", (await agg(F, "total", "event_type = 'purchase'"))[0]?.units === 1);
  t("ingested events aggregate like any other (IN/TN, google/organic)",
    (await agg(F, "location", "region = 'TN'")).length === 1 && (await agg(F, "source", "source = 'google' and medium = 'organic'")).length === 1);
  t("no money anywhere in the aggregates", !(await q("select column_name c from information_schema.columns where table_name = 'analytics_daily'")).some((x) => /revenue|inr|price|value/.test(String(x.c))));

  console.log("\naggregation: product history");
  const H = await day(-12);
  const P3 = await product("Old Name Saree", "agg-old");
  await ev(H, { type: "product_view", product: P3, category: cat });
  await rollup(H);
  await q("update products set name = 'Renamed Saree', is_active = false, category_id = $2 where id = $1", [P3, cat2]);
  await asAdmin(c, admin);
  let rep = (await one("select analytics_report($1::date, $1::date, 'product') r", [H])).r as Row;
  let row = (rep.rows as Row[]).find((x) => x.product_id === P3);
  t("23. a renamed, unpublished, recategorised product keeps its history, under its current name",
    row?.events === 1 && row?.product_name === "Renamed Saree" && row?.product_exists === true);
  await asRoot(c);
  t("23. the aggregate keeps the category it had that day", (await agg(H, "product", "product_id = $3", [P3]))[0]?.category_id === cat);
  await q("delete from products where id = $1", [P3]);
  await asAdmin(c, admin);
  rep = (await one("select analytics_report($1::date, $1::date, 'product') r", [H])).r as Row;
  row = (rep.rows as Row[]).find((x) => x.product_id === P3);
  t("23. a deleted product keeps its id, count and last known name", row?.events === 1 && row?.product_name === "Old Name Saree" && row?.product_exists === false);
  await asRoot(c);

  const H2 = await day(-13);
  const P4 = await product("Gone Before Rollup", "agg-gone");
  const O4 = await order([{ id: P4, name: "Gone Before Rollup", quantity: 2, price_inr: 1000 }]);
  await ev(H2, { type: "purchase", order: O4, device: null, country: null, region: null });
  await q("delete from products where id = $1", [P4]);
  await rollup(H2);
  const gone = (await agg(H2, "product", "event_type = 'purchase'"))[0];
  t("23. a purchased product deleted before its day was rolled up keeps id, units and the name from the order line",
    gone?.product_id === P4 && gone?.units === 2 && gone?.product_name === "Gone Before Rollup");

  console.log("\nreconciliation");
  await asAdmin(c, admin);
  let rc = (await one("select analytics_reconcile($1::date) r", [D])).r as Row;
  const line = (r: Row, type: string) => (r.by_event_type as Row[]).find((x) => x.event_type === type) as Row;
  t("24. raw customer events = aggregate total, every grain sums back, for every type", rc.all_match === true, JSON.stringify(rc.by_event_type));
  t("6. reconciliation shows customer / internal / test separately",
    line(rc, "page_view").raw_customer === 4 && line(rc, "page_view").raw_internal === 2 && line(rc, "page_view").raw_test === 1 && line(rc, "purchase").raw_test === 1);
  t("24. 'why 3 product views?': raw 3 = total 3 = product 3 = location 3 = device 3 = source 3",
    ["raw_customer", "aggregate_total", "product_grain", "location_grain", "device_grain", "source_grain"].every((k) => line(rc, "product_view")[k] === 3));
  t("reconciliation states the exact UTC window of the IST day",
    rc.timezone === "Asia/Kolkata" && new Date(String(rc.utc_from)).toISOString() === new Date(`${D}T00:00:00+05:30`).toISOString());
  t("reconciliation carries counts only — no event, order or product id", !JSON.stringify(rc).match(/[0-9a-f]{8}-[0-9a-f]{4}-/));
  await asRoot(c);
  await q("update analytics_daily set events = events + 1 where day = $1::date and grain = 'device' and event_type = 'page_view' and device = 'mobile'", [D]);
  await asAdmin(c, admin);
  rc = (await one("select analytics_reconcile($1::date) r", [D])).r as Row;
  t("24. a tampered aggregate is caught", rc.all_match === false && line(rc, "page_view").matches === false);
  await asRoot(c);
  await rollup(D);
  await asAdmin(c, admin);
  t("24. …and a rebuild from raw puts it right", ((await one("select analytics_reconcile($1::date) r", [D])).r as Row).all_match === true);
  const nr = (await one("select analytics_reconcile($1::date) r", [await day(-25)])).r as Row;
  t("a day never rolled up does not reconcile (unknown, not zero)", nr.rolled_up === false && nr.all_match === false);

  console.log("\nreports (the 1C contract)");
  rep = (await one("select analytics_report($1::date, $2::date, 'total') r", [await day(-12), await day(-10)])).r as Row;
  t("total: a daily series, customer only, every day covered", rep.traffic === "customer" && rep.days === 3 && rep.covered_days === 3 &&
    (rep.missing_days as string[]).length === 0 && (rep.rows as Row[]).length > 0 && (rep.rows as Row[]).every((x) => typeof x.day === "string"));
  rep = (await one("select analytics_report($1::date, $2::date, 'total') r", [await day(-26), await day(-25)])).r as Row;
  t("a range with no rollup reports those days as missing, not as zero", rep.covered_days === 0 && (rep.missing_days as string[]).length === 2);
  rep = (await one("select analytics_report($1::date, $1::date, 'location') r", [D])).r as Row;
  t("location report flags the unknown row as unknown", (rep.rows as Row[]).some((x) => x.unknown === true && x.country_code === undefined));
  t("reports refuse a range over 5 years or a made-up grain",
    (await failure(() => c.query("select analytics_report(current_date - 2000, current_date, 'total')"))).includes("invalid range") &&
    (await failure(() => c.query("select analytics_report(current_date - 1, current_date, 'visitors')"))).includes("unknown grain"));
  await asRoot(c);

  console.log("\nretention");
  const OLD = await day(-200);
  const OLD_UNCOVERED = await day(-199);
  const OLD_CHANGED = await day(-198);
  const KEEP = await day(-100);
  for (const d of [OLD, OLD_UNCOVERED, OLD_CHANGED, KEEP]) {
    await ev(d, { type: "page_view" });
    await ev(d, { type: "product_view", product: P1 });
    await ev(d, { type: "page_view", traffic: "internal" });
  }
  await rollup(OLD);
  await rollup(OLD_CHANGED);
  await rollup(KEEP);
  await ev(OLD_CHANGED, { type: "page_view" }); // arrived after its rollup
  const rawIn = async (d: string) => Number((await one("select count(*) n from analytics_events where occurred_at >= analytics_day_start($1::date) and occurred_at < analytics_day_start($1::date + 1)", [d])).n);
  const p1 = (await one("select analytics_purge(180) p")).p as Row;
  t("26. purge removes the raw rows of an old, covered, matching day (all classes)", (p1.days as string[]).includes(OLD) && (await rawIn(OLD)) === 0 && p1.events === 3, JSON.stringify(p1));
  t("never purges an old day with no rollup", (await rawIn(OLD_UNCOVERED)) === 3 && (p1.skipped as Row[]).some((s) => s.day === OLD_UNCOVERED && s.reason === "not rolled up"));
  t("never purges an old day whose raw rows changed since its rollup", (await rawIn(OLD_CHANGED)) === 4 && (p1.skipped as Row[]).some((s) => s.day === OLD_CHANGED && s.reason === "raw rows differ from the rollup"));
  t("25. never purges inside the retention window", (await rawIn(KEEP)) === 3 && (await rawIn(D)) > 0);
  t("27. the aggregate survives the purge", (await total(OLD, "page_view")) === 1 && (await total(OLD, "product_view")) === 1);
  t("27. the run records when and how much was purged", (await one("select raw_purged_events n, raw_purged_at is not null p from analytics_daily_runs where day = $1::date", [OLD])).n === 3);
  t("27. a purged day can never be rebuilt (that would erase it)", (await failure(() => rollup(OLD))).includes("purged"));
  await asAdmin(c, admin);
  const rcOld = (await one("select analytics_reconcile($1::date) r", [OLD])).r as Row;
  t("27. reconciliation of a purged day says so and still checks the grains", rcOld.raw_retained === false && rcOld.all_match === true && line(rcOld, "page_view").raw_customer === undefined);
  await asRoot(c);
  const p2 = (await one("select analytics_purge(180) p")).p as Row;
  t("28. purge again: nothing more is deleted", p2.events === 0 && (await total(OLD, "page_view")) === 1);
  t("purge refuses fewer than 30 days", (await failure(() => c.query("select analytics_purge(29)"))).includes("at least 30"));
  for (let i = 0; i < 9; i++) await ev(await day(-300 - i), { type: "page_view" });
  for (let i = 0; i < 9; i++) await rollup(await day(-300 - i));
  const p3 = (await one("select analytics_purge(180) p")).p as Row;
  t("purge is bounded: at most 7 days a call, and says more remain", (p3.days as string[]).length === 7 && p3.more_remaining === true);

  console.log("\nthe nightly job");
  const MISSED = await day(-5);
  await ev(MISSED, { type: "page_view" });
  await ev(await day(-2), { type: "page_view" });
  const STALE = await day(-30);
  await ev(STALE, { type: "page_view" });
  await rollup(STALE);
  await ev(STALE, { type: "page_view" }); // a raw change in the 35-day window
  const n1 = (await one("select analytics_nightly() r")).r as Row;
  const rebuilt = n1.rebuilt as string[];
  t("the nightly job rebuilds the last 3 finished days", [await day(-1), await day(-2), await day(-3)].every((d) => rebuilt.includes(d)), JSON.stringify(rebuilt));
  t("…a day it missed", rebuilt.includes(MISSED) && (await total(MISSED, "page_view")) === 1);
  t("…and a day in the last 35 whose raw rows changed", rebuilt.includes(STALE) && (await total(STALE, "page_view")) === 2);
  t("…but not today (unfinished) or an older day that still matches", !rebuilt.includes(today) && !rebuilt.includes(D));
  t("…and runs the purge after", n1.ok === true && (n1.purge as Row).keep_days === 180);
  t("every run is logged", (await one("select count(*) n from analytics_job_log where job = 'nightly' and ok")).n === "1");
  const n2 = (await one("select analytics_nightly() r")).r as Row;
  t("a second run on the same night is harmless (same totals)", n2.ok === true && (await total(MISSED, "page_view")) === 1 && (await total(STALE, "page_view")) === 2);
  await ev(await day(-400), { type: "page_view" });
  await rollup(await day(-400));
  await q("alter table analytics_daily add constraint agg_test_break check (day < date '2000-01-01') not valid");
  const n3 = (await one("select analytics_nightly() r")).r as Row;
  await q("alter table analytics_daily drop constraint agg_test_break");
  t("a failed rebuild is logged with its stage and error", n3.ok === false && n3.stage === "rollup" &&
    (await one("select count(*) n from analytics_job_log where not ok and detail->>'stage' = 'rollup'")).n === "1");
  t("a failed rebuild purges nothing", (await rawIn(await day(-400))) === 1);
  t("the job log is visible in reconciliation", await (async () => {
    await asAdmin(c, admin);
    const r = (await one("select analytics_reconcile($1::date) r", [D])).r as Row;
    await asRoot(c);
    return (r.last_jobs as Row[]).some((j) => j.ok === false && j.stage === "rollup");
  })());

  console.log("\nscheduler and access");
  t("29. 0070 scheduled nothing here (no pg_cron in the harness) and did not fail", (await q("select 1 from pg_namespace where nspname = 'cron'")).length === 0);
  const ownerOnly = ["analytics_rollup_day($1::date)", "analytics_nightly()", "analytics_purge(180)"];
  const denied = async (label: string) => {
    for (const f of ownerOnly) {
      const msg = await failure(() => c.query(`select ${f}`, f.includes("$1") ? [D] : []));
      if (!msg.includes("permission denied")) return t(`${label}: cannot run ${f}`, false, msg);
    }
    for (const tbl of ["analytics_daily", "analytics_daily_runs", "analytics_job_log"]) {
      const msg = await failure(() => c.query(`select 1 from ${tbl} limit 1`));
      if (!msg.includes("permission denied")) return t(`${label}: cannot read ${tbl}`, false, msg);
    }
    t(`${label}: cannot run rollup, nightly or purge, or read any aggregate table`, true);
  };
  await asService(c);
  await denied("29. service_role");
  await asRoot(c);
  await c.query("set role anon");
  await denied("30. anonymous");
  t("30. anonymous cannot call the report or reconciliation",
    (await failure(() => c.query("select analytics_report(current_date - 1, current_date, 'total')"))).includes("permission denied") &&
    (await failure(() => c.query("select analytics_reconcile(current_date - 1)"))).includes("permission denied"));
  await asRoot(c);
  await asUser(c, cust, "aal1");
  await denied("30. customer");
  t("30. a customer cannot read the report or reconciliation",
    (await failure(() => c.query("select analytics_report(current_date - 1, current_date, 'total')"))).includes("Only admins") &&
    (await failure(() => c.query("select analytics_reconcile(current_date - 1)"))).includes("Only admins"));
  await asRoot(c);
  await asStaffPasswordOnly(c, admin);
  t("31. staff without the second factor cannot read reports", (await failure(() => c.query("select analytics_report(current_date - 1, current_date, 'total')"))).includes("Only admins"));
  await asRoot(c);
  await asAdmin(c, admin);
  await denied("a verified admin through the API");
  t("32. a verified admin (aal2, live session) can read the report and reconciliation",
    ((await one("select analytics_report($1::date, $1::date, 'product') r", [D])).r as Row).rows !== undefined &&
    ((await one("select analytics_reconcile($1::date) r", [D])).r as Row).all_match === true);
  const claims = (await one("select current_setting('request.jwt.claims') c")).c as string;
  await c.query("reset role");
  await c.query("delete from auth.sessions where user_id = $1", [admin]);
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [admin, claims]);
  t("31. the same admin token after its session was revoked cannot read",
    (await failure(() => c.query("select analytics_report(current_date - 1, current_date, 'total')"))).includes("Only admins") &&
    (await failure(() => c.query("select analytics_reconcile(current_date - 1)"))).includes("Only admins"));
  await asRoot(c);
  t("aggregate tables: RLS on, no policies",
    (await one("select bool_and(relrowsecurity) r from pg_class where relname in ('analytics_daily','analytics_daily_runs','analytics_job_log')")).r === true &&
    (await one("select count(*) n from pg_policies where tablename in ('analytics_daily','analytics_daily_runs','analytics_job_log')")).n === "0");
  t("every new function is SECURITY DEFINER with a pinned search_path (or a plain SQL helper)",
    (await one(`select bool_and(prosecdef and proconfig::text like '%search_path=public, pg_temp%') ok from pg_proc
                 where proname in ('analytics_rollup_day','analytics_nightly','analytics_purge','analytics_report','analytics_reconcile')`)).ok === true);
}

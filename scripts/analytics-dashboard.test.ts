/**
 * Analytics 1C: Admin Analytics V1 — what the dashboard shows and how each
 * figure is derived (lib/analyticsDashboard), what its components may and may
 * not say, and — end to end on a throwaway Postgres — that the figures it
 * builds from the real 1B functions are right, customer-only, and readable
 * only by a verified admin with a live session. Design: docs/analytics.md §10.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/analytics-dashboard.test.ts
 *
 * Without the harness the pure and source checks still run and the process
 * exits 2 (database skipped). Nothing here touches production.
 */
import fs from "node:fs";
import path from "node:path";
import {
  addDays,
  campaignLines,
  classesFromDiagnostics,
  compare,
  countryLines,
  coverageOf,
  dailySeries,
  describeChange,
  describeGaps,
  deviceLines,
  formatIstTime,
  formatPer100,
  funnel,
  healthFrom,
  istDay,
  istDayStart,
  isIsoDay,
  latestCoveredDay,
  metaFromProduct,
  OVERVIEW_METRICS,
  per100,
  previousLabel,
  previousRange,
  productLines,
  referrerLines,
  regionLines,
  regionName,
  resolveRange,
  searchLines,
  sortRows,
  sourceLabel,
  sourceLines,
  spanDays,
  totalsFromDiagnostics,
  totalsFromReport,
  zeroResultLines,
  DELETED_UNNAMED,
  type Diagnostics,
  type GrainRow,
  type ProductMeta,
  type Reconcile,
  type Report,
  type TotalRow,
} from "../lib/analyticsDashboard";
import { asAdmin, asRoot, asStaffPasswordOnly, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}
const read = (p: string) => fs.readFileSync(p, "utf8");
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const gr = (o: Partial<GrainRow> & Pick<GrainRow, "event_type" | "events">): GrainRow => ({ units: null, entries: 0, unknown: false, ...o });

function pure() {
  console.log("\ndates and ranges (IST)");
  // 2026-10-12 00:10 IST = 2026-10-11 18:40 UTC
  const justAfterMidnight = new Date("2026-10-11T18:40:00Z");
  t("6. IST boundary: 18:40 UTC is already the next IST day", istDay(justAfterMidnight) === "2026-10-12");
  t("6. IST boundary: 18:29:59 UTC is still the IST day before", istDay(new Date("2026-10-11T18:29:59Z")) === "2026-10-11");
  t("6. an IST day starts at 18:30 UTC the day before", istDayStart("2026-10-12").toISOString() === "2026-10-11T18:30:00.000Z");
  t("IST does not depend on the machine's time zone (fixed +05:30, no DST)",
    istDay(new Date("2026-03-29T01:30:00Z")) === "2026-03-29" && istDay(new Date("2026-12-31T18:30:00Z")) === "2027-01-01");
  t("addDays / spanDays across a month end", addDays("2026-10-31", 1) === "2026-11-01" && spanDays("2026-09-25", "2026-10-24") === 30);
  t("isIsoDay rejects impossible dates and junk", isIsoDay("2026-02-28") && !isIsoDay("2026-02-30") && !isIsoDay("12/10/2026") && !isIsoDay(undefined));

  const now = new Date("2026-10-12T09:00:00Z"); // 14:30 IST on 12 Oct
  const r = (p: Parameters<typeof resolveRange>[0], c?: { from?: string; to?: string }) => resolveRange(p, now, c);
  const today = r("today");
  t("Today = the current IST day, live (provisional)", today.ok && today.range.from === "2026-10-12" && today.range.to === "2026-10-12" && today.range.live);
  const yday = r("yesterday");
  t("Yesterday = the previous IST day, final", yday.ok && yday.range.from === "2026-10-11" && yday.range.to === "2026-10-11" && !yday.range.live);
  const d7 = r("7d");
  t("Last 7 days = the 7 finished days ending yesterday (never today)", d7.ok && d7.range.from === "2026-10-05" && d7.range.to === "2026-10-11" && d7.range.days === 7);
  const d30 = r("30d");
  t("Last 30 days = 30 finished days ending yesterday", d30.ok && d30.range.from === "2026-09-12" && d30.range.to === "2026-10-11" && d30.range.days === 30);
  t("Custom: a valid range", (() => { const c = r("custom", { from: "2026-10-01", to: "2026-10-03" }); return c.ok && c.range.days === 3; })());
  t("Custom: cannot include today (in progress)", (() => { const c = r("custom", { from: "2026-10-10", to: "2026-10-12" }); return !c.ok && /today is still in progress/.test(c.error); })());
  t("Custom: end before start refused", !r("custom", { from: "2026-10-05", to: "2026-10-01" }).ok);
  t("Custom: more than 366 days refused", !r("custom", { from: "2025-01-01", to: "2026-10-01" }).ok);
  t("Custom: missing dates refused", !r("custom", {}).ok);

  console.log("\ncomparison");
  t("4. 7 days compare with the 7 days before", d7.ok && eq(previousRange(d7.range), { from: "2026-09-28", to: "2026-10-04" }));
  t("4. 30 days compare with the 30 days before", d30.ok && eq(previousRange(d30.range), { from: "2026-08-13", to: "2026-09-11" }));
  t("4. Yesterday compares with the day before", yday.ok && eq(previousRange(yday.range), { from: "2026-10-10", to: "2026-10-10" }) && previousLabel(yday.range) === "the day before");
  t("4. Custom compares with the immediately preceding equal-length period",
    (() => { const c = r("custom", { from: "2026-10-01", to: "2026-10-03" }); return c.ok && eq(previousRange(c.range), { from: "2026-09-28", to: "2026-09-30" }); })());
  t("4. Today is never compared (a partial day vs a finished one)", today.ok && previousRange(today.range) === null);
  const up = describeChange(compare(245, 207), "the previous 7 days");
  t("percentage change with direction in words", up.text === "Up 18% vs the previous 7 days (was 207)" && up.direction === "up", up.text);
  t("down", describeChange(compare(5, 10), "the previous 7 days").text.startsWith("Down 50%"));
  t("5. previous period zero, now >0 → New (never an infinite %)",
    eq(compare(4, 0), { kind: "new" }) && describeChange(compare(4, 0), "the day before").text === "New — none on the day before" && !/Infinity|NaN/.test(describeChange(compare(4, 0), "x").text));
  t("5. both zero → —", eq(compare(0, 0), { kind: "none" }) && describeChange(compare(0, 0), "x").text.startsWith("—"));
  t("previous period not fully processed → no comparison", eq(compare(9, null), { kind: "unavailable" }) && describeChange(compare(9, null), "x").text.includes("no comparison"));
  t("tiny change shows <1%, not 0%", describeChange(compare(1001, 1000), "x").text.startsWith("Up <1%"));

  console.log("\ncoverage and freshness");
  const cov = (missing: string[]): Pick<Report, "from" | "to" | "days" | "covered_days" | "missing_days"> =>
    ({ from: "2026-10-05", to: "2026-10-11", days: 7, covered_days: 7 - missing.length, missing_days: missing });
  t("complete coverage → no note", describeGaps(cov([])) === null && coverageOf(cov([])) === "complete");
  t("1. zero coverage → none (unknown, not zero)", coverageOf(cov(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"])) === "none");
  const leading = describeGaps(cov(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]))!;
  t("leading gap explained as 'figures start on …'", leading.includes("Covers 2 of 7 days") && leading.includes("figures start on 10 Oct 2026"), leading);
  t("later gap explained as 'not processed yet'", describeGaps(cov(["2026-10-11"]))!.includes("1 later day is not processed yet"));
  t("one-day range not processed → says when it will be", describeGaps({ from: "2026-10-11", to: "2026-10-11", days: 1, covered_days: 0, missing_days: ["2026-10-11"] })!.includes("2:00 am IST"));
  t("7. data-through = latest covered day", latestCoveredDay({ from: "2026-10-05", to: "2026-10-11", missing_days: ["2026-10-11"] }) === "2026-10-10");
  t("7. freshness label is in IST", formatIstTime("2026-10-11T20:30:00Z") === "12 Oct 2026, 2:00 am IST", formatIstTime("2026-10-11T20:30:00Z"));

  console.log("\ntotals, series and today");
  const totals: TotalRow[] = [
    { day: "2026-10-10", event_type: "page_view", events: 5, units: null, entries: 2 },
    { day: "2026-10-11", event_type: "page_view", events: 3, units: null, entries: 1 },
    { day: "2026-10-11", event_type: "cart_add", events: 2, units: 3, entries: 0 },
    { day: "2026-10-11", event_type: "purchase", events: 1, units: 2, entries: 0 },
  ];
  const tt = totalsFromReport(totals);
  t("2. totals sum across days; units kept", tt.page_view.events === 8 && tt.cart_add.units === 3 && tt.purchase.units === 2 && tt.search.events === 0);
  const series = dailySeries({ from: "2026-10-08", to: "2026-10-11", grain: "total", days: 4, covered_days: 3, missing_days: ["2026-10-08"], rows: totals }, "page_view");
  t("3. daily series: covered zero days are 0, missing days are left out", eq(series, [{ day: "2026-10-09", value: 0 }, { day: "2026-10-10", value: 5 }, { day: "2026-10-11", value: 3 }]));
  const diag: Diagnostics = {
    collecting: true,
    collecting_changed_at: null,
    by_type: [
      { event_type: "page_view", traffic: "customer", events: 4 },
      { event_type: "page_view", traffic: "internal", events: 9 },
      { event_type: "purchase", traffic: "test", events: 2 },
    ],
  };
  t("41/42. today's live count is customer only", totalsFromDiagnostics(diag).page_view.events === 4 && totalsFromDiagnostics(diag).purchase.events === 0);
  t("traffic classes kept apart for the status panel", eq(classesFromDiagnostics(diag), { customer: 4, internal: 9, test: 2 }));
  t("overview cards are exactly the eight agreed metrics",
    eq(OVERVIEW_METRICS.map((m) => m.label), ["Page views", "Product views", "Searches", "Wishlist adds", "Cart adds", "Checkout starts", "Purchases", "WhatsApp clicks"]));

  console.log("\nfunnel");
  const f = funnel({ ...totalsFromReport([]), product_view: { events: 200, units: 0 }, cart_add: { events: 20, units: 25 }, checkout_start: { events: 30, units: 0 }, purchase: { events: 0, units: 0 } });
  t("8. the four steps in order", eq(f.map((s) => s.type), ["product_view", "cart_add", "checkout_start", "purchase"]));
  t("8. ratios per 100 with the §9.5 denominators", f[1].ratio === 10 && f[2].ratio === 150 && f[3].ratio === 0);
  t("9. a later step above an earlier one is shown as it is (not clamped)", f[2].events === 30 && f[2].exceedsPrevious && f[2].ratio === 150);
  const fz = funnel(totalsFromReport([]));
  t("10. zero denominator → no ratio (—), never Infinity/NaN", fz[1].ratio === null && formatPer100(fz[1].ratio) === "—" && per100(5, 0) === null);
  t("11. zero purchases are shown as 0", f[3].events === 0);
  t("12. ratio labels say 'per 100', never conversion", f.every((s) => !s.ratioLabel || (/per 100/.test(s.ratioLabel) && !/conversion/i.test(s.ratioLabel))));
  t("per-100 formatting", formatPer100(12.345) === "12" && formatPer100(3.25) === "3.3" && formatPer100(0) === "0");

  console.log("\nproducts");
  const meta = new Map<string, ProductMeta>([
    ["p1", { id: "p1", name: "Kasavu Saree", category: "Sarees", status: "live" }],
    ["p2", { id: "p2", name: "Set Mundu", category: "Mundu", status: "hidden" }],
    ["p3", { id: "p3", name: "New Dhoti", category: "Mundu", status: "never-published" }],
    ["p4", { id: "p4", name: "Quiet Stole", category: "Stoles", status: "live" }],
  ]);
  const prow: GrainRow[] = [
    gr({ event_type: "product_view", events: 10, product_id: "p1", product_name: "Kasavu Saree (renamed)", product_exists: true }),
    gr({ event_type: "cart_add", events: 3, units: 4, product_id: "p1", product_name: "Kasavu Saree (renamed)", product_exists: true }),
    gr({ event_type: "wishlist_add", events: 2, product_id: "p1", product_name: "Kasavu Saree (renamed)", product_exists: true }),
    gr({ event_type: "purchase", events: 2, units: 3, product_id: "p1", product_name: "Kasavu Saree (renamed)", product_exists: true }),
    gr({ event_type: "product_view", events: 4, product_id: "p2", product_name: "Set Mundu", product_exists: true }),
    gr({ event_type: "product_view", events: 1, product_id: "p9", product_name: "Old Shawl", product_exists: false }),
    gr({ event_type: "product_view", events: 2 }), // deleted before rollup: no id, no name
    gr({ event_type: "cart_add", events: 1, units: 1 }),
  ];
  const pl = productLines(prow, meta);
  const by = (k: string) => pl.find((l) => l.key === k)!;
  t("15. renamed product shows the name the report gives (current)", by("p1").name === "Kasavu Saree (renamed)");
  t("product line sums: views, wishlist, cart, purchases (orders), units sold",
    by("p1").views === 10 && by("p1").wishlistAdds === 2 && by("p1").cartAdds === 3 && by("p1").purchases === 2 && by("p1").unitsSold === 3);
  t("14. category from the current product list", by("p1").category === "Sarees" && by("p2").category === "Mundu");
  t("16. unpublished/hidden product keeps its history and is marked", by("p2").status === "hidden" && by("p2").views === 4);
  t("17. deleted product (rolled up before deletion) keeps its stored name, marked Deleted", by("p9").name === "Old Shawl" && by("p9").status === "deleted" && by("p9").category === null);
  const unnamed = pl.find((l) => l.productId === null)!;
  t("17. deleted before rollup: kept as 'Deleted product (name not kept)', its views and cart adds not dropped",
    unnamed.name === DELETED_UNNAMED && unnamed.status === "deleted" && unnamed.views === 2 && unnamed.cartAdds === 1);
  t("view → cart indicator = cart adds per 100 views (null with no views)", by("p1").cartPer100Views === 30 && by("p2").cartPer100Views === 0 && unnamed.cartPer100Views === 50);
  t("18. zero-activity products are hidden by default…", !pl.some((l) => l.key === "p3" || l.key === "p4"));
  const plAll = productLines(prow, meta, { includeInactive: true });
  t("18. …and listed with zeros when asked, with status (never published)",
    plAll.find((l) => l.key === "p3")?.views === 0 && plAll.find((l) => l.key === "p3")?.status === "never-published" && plAll.find((l) => l.key === "p4")?.cartPer100Views === null);
  const desc = sortRows(plAll, (l) => l.cartPer100Views, "desc", (l) => l.name);
  const asc = sortRows(plAll, (l) => l.cartPer100Views, "asc", (l) => l.name);
  t("13. sorting: numeric desc, ties by name, nulls (no views) last in BOTH directions",
    eq(desc.map((l) => l.key).slice(0, 2), ["deleted:", "p1"]) && desc.at(-1)!.cartPer100Views === null && asc.at(-1)!.cartPer100Views === null &&
    asc[0].cartPer100Views === 0 && eq(desc.filter((l) => l.cartPer100Views === 0).map((l) => l.name), ["Old Shawl", "Set Mundu"]));
  t("product list without current details still shows history (status unknown, no category)",
    (() => { const x = productLines(prow, null); return x.find((l) => l.key === "p1")!.status === null && x.find((l) => l.key === "p1")!.category === null && x.find((l) => l.key === "p9")!.status === "deleted"; })());
  t("13. sorting by text A→Z", sortRows(pl, (l) => l.name, "asc", (l) => l.name)[0].name === DELETED_UNNAMED);
  t("metaFromProduct: never published / hidden / live",
    metaFromProduct({ id: "a", name: "A" }).status === "never-published" &&
    metaFromProduct({ id: "a", name: "A", publication: { hasPublished: true, liveVisible: false } }).status === "hidden" &&
    metaFromProduct({ id: "a", name: "A", category: "Sarees", publication: { hasPublished: true, liveVisible: true } }).status === "live");

  console.log("\nsources and campaigns");
  const srows: GrainRow[] = [
    gr({ event_type: "page_view", events: 5, source: "direct", medium: "none", unknown: false }),
    gr({ event_type: "page_view", events: 2, unknown: true }),
    gr({ event_type: "page_view", events: 3, source: "google", medium: "organic", referrer_host: "www.google.com" }),
    gr({ event_type: "cart_add", events: 1, units: 1, source: "google", medium: "organic", referrer_host: "www.google.com" }),
    gr({ event_type: "page_view", events: 4, source: "instagram", medium: "social", campaign: "onam_2026", referrer_host: "l.instagram.com" }),
    gr({ event_type: "product_view", events: 2, source: "instagram", medium: "social", campaign: "onam_2026", referrer_host: "l.instagram.com" }),
    gr({ event_type: "page_view", events: 1, source: "chatgpt", medium: "referral", referrer_host: "chatgpt.com" }),
    gr({ event_type: "page_view", events: 1, source: "newsletter", medium: "email", campaign: "diwali" }),
  ];
  const sl = sourceLines(srows);
  t("19. Direct is its own line", sl.find((l) => l.label === "Direct")?.counts.page_view === 5);
  t("20. Unknown stays visible (not spread over other sources)", sl.find((l) => l.unknown)?.label === "Unknown" && sl.find((l) => l.unknown)?.counts.page_view === 2 &&
    sl.reduce((n, l) => n + l.counts.page_view, 0) === 16);
  t("21. Google from its referrer, with its cart adds", sl.find((l) => l.label === "Google")?.counts.cart_add === 1);
  t("23. an AI assistant is listed only when observed (ChatGPT yes; Claude/Gemini/Perplexity no)",
    sl.some((l) => l.label === "ChatGPT") && !sl.some((l) => /Claude|Gemini|Perplexity|Copilot/.test(l.label)));
  t("a utm_source label not in the known list is shown as received", sl.some((l) => l.label === "newsletter"));
  t("sourceLabel(null) = Unknown", sourceLabel(null) === "Unknown" && sourceLabel("other") === "Other websites");
  const cl = campaignLines(srows);
  t("22. campaigns: only tagged rows, with source / medium", cl.length === 2 && cl[0].label === "onam_2026" && cl[0].detail === "Instagram / social" && cl[0].counts.product_view === 2);
  t("referring websites by host", referrerLines(srows).map((l) => l.label).sort().join() === "chatgpt.com,l.instagram.com,www.google.com");
  t("no campaign data → empty campaign list (empty state)", campaignLines(srows.filter((r) => !r.campaign)).length === 0);

  console.log("\ngeography and devices");
  const grows: GrainRow[] = [
    gr({ event_type: "page_view", events: 6, country_code: "IN", region: "KL" }),
    gr({ event_type: "page_view", events: 2, country_code: "IN", region: "KA" }),
    gr({ event_type: "page_view", events: 1, country_code: "IN" }),
    gr({ event_type: "page_view", events: 3, country_code: "GB", region: "SCT" }),
    gr({ event_type: "page_view", events: 2, unknown: true }),
  ];
  const cl2 = countryLines(grows);
  t("24. countries named (India, United Kingdom) and summed", cl2[0].label === "India" && cl2[0].counts.page_view === 9 && cl2.some((l) => l.label === "United Kingdom"));
  t("26. unknown country stays visible", cl2.some((l) => l.unknown && l.label === "Unknown" && l.counts.page_view === 2));
  const rl = regionLines(grows);
  t("25. regions named within their country (Kerala, India; Scotland, United Kingdom)",
    rl[0].label === "Kerala" && rl[0].detail === "India" && rl.some((l) => l.label === "Scotland" && l.detail === "United Kingdom"));
  t("26. a known country with no region → 'Unknown region'", rl.some((l) => l.label === "Unknown region" && l.detail === "India" && l.unknown));
  t("an unmapped region code is shown as the code", regionName("FR", "IDF") === "Region IDF" && regionName("IN", "TN") === "Tamil Nadu" && regionName("GB", "ENG") === "England");
  const drows: GrainRow[] = [
    gr({ event_type: "page_view", events: 5, device: "mobile" }),
    gr({ event_type: "page_view", events: 3, device: "desktop" }),
    gr({ event_type: "checkout_start", events: 1, device: "desktop" }),
    gr({ event_type: "page_view", events: 1, device: "tablet" }),
    gr({ event_type: "page_view", events: 2, unknown: true }),
  ];
  const dl = deviceLines(drows);
  t("28–31. mobile, desktop, tablet and unknown each a line", eq(dl.map((l) => l.label), ["Mobile", "Desktop", "Unknown", "Tablet"]) && dl.find((l) => l.label === "Desktop")!.counts.checkout_start === 1);

  console.log("\nsearch");
  const qrows: GrainRow[] = [
    gr({ event_type: "search", events: 5, search_term: "kasavu", zero_results: false }),
    gr({ event_type: "search", events: 1, search_term: "kasavu", zero_results: true }),
    gr({ event_type: "search", events: 4, search_term: "linen shirt", zero_results: true }),
    gr({ event_type: "search", events: 2, search_term: "(redacted)", zero_results: true }),
    gr({ event_type: "search", events: 3, search_term: "mundu" }), // result count not captured
  ];
  const ql = searchLines(qrows);
  t("32. top searches, most first", eq(ql.map((l) => l.term), ["kasavu", "linen shirt", "mundu", "(redacted)"]) && ql[0].searches === 6);
  t("33. zero-result counts and rate over known-result searches", ql[0].zeroResults === 1 && Math.round(ql[0].zeroRate!) === 17 && ql[1].zeroRate === 100);
  t("rate undefined when no result count was captured", ql.find((l) => l.term === "mundu")!.zeroRate === null);
  t("34. '(redacted)' stays '(redacted)' and is flagged", ql.find((l) => l.redacted)?.term === "(redacted)");
  t("33. 'found nothing' list, most-missed first", eq(zeroResultLines(ql).map((l) => l.term), ["linen shirt", "(redacted)", "kasavu"]));
  t("35. empty search report → no lines", searchLines([]).length === 0);

  console.log("\nhealth");
  const rec: Reconcile = {
    day: "2026-10-11", rolled_up: true, rolled_up_at: "2026-10-11T20:30:00Z", raw_at_rollup: { customer: 0, internal: 18, test: 0 },
    raw_retained: true, all_match: true,
    last_jobs: [{ ran_at: "2026-10-11T20:30:00Z", job: "nightly", ok: true }],
  };
  const h = healthFrom({ diagnostics: diag, coverage: { from: "2026-09-07", to: "2026-10-11", missing_days: [] }, reconcile: rec });
  t("health: on, data through, last success, reconciled, classes", h.collecting === true && h.dataThrough === "2026-10-11" && h.lastSuccessfulRun === "2026-10-11T20:30:00Z" &&
    h.reconciled === true && eq(h.classes, { customer: 0, internal: 18, test: 0 }) && h.problem === null);
  t("health: switch off is a problem", healthFrom({ diagnostics: { ...diag, collecting: false }, coverage: null, reconcile: rec }).problem!.includes("switched off"));
  t("health: failed nightly run is a problem, last success still shown",
    (() => { const x = healthFrom({ diagnostics: diag, coverage: null, reconcile: { ...rec, last_jobs: [{ ran_at: "2026-10-12T20:30:00Z", job: "nightly", ok: false, stage: "rollup" }, ...rec.last_jobs] } });
      return x.problem!.includes("rollup step") && x.lastSuccessfulRun === "2026-10-11T20:30:00Z"; })());
  t("health: a mismatch is a problem", healthFrom({ diagnostics: diag, coverage: null, reconcile: { ...rec, all_match: false } }).problem!.includes("do not reconcile"));
}

function sources() {
  console.log("\nsource checks");
  const files = [
    "components/admin/analytics/ShopAnalytics.tsx",
    "components/admin/analytics/OverviewViews.tsx",
    "components/admin/analytics/BreakdownViews.tsx",
    "components/admin/analytics/ui.tsx",
    "lib/analyticsDashboard.ts",
    "lib/analyticsDashboardSource.ts",
    "app/(admin)/admin/dashboard/analytics/page.tsx",
  ];
  const all = files.map(read).join("\n");
  // Visible text only: strings and JSX text. Comments may explain what is NOT shown.
  const visible = files.filter((f) => f.endsWith(".tsx") || f.endsWith("analyticsDashboard.ts")).map(read).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  t("12. no 'conversion rate' wording anywhere in the dashboard", !/conversion/i.test(visible));
  t("no visitor/session/bounce METRIC is shown (only the 'not enabled' note)",
    !/\b(unique visitors?|returning visitors?|bounce rate|sessions?:|repeat visitor)/i.test(visible) &&
    visible.includes("Visitor and session metrics are not enabled"));
  t("no revenue, AOV or ROAS figure in the new views", !/formatINR|average order|\bAOV\b|ROAS|revenue_inr/i.test(files.slice(0, 5).map(read).join("\n")));
  const src = read("lib/analyticsDashboardSource.ts");
  t("the dashboard reads ONLY analytics_report / analytics_reconcile / analytics_diagnostics (+ the admin product list)",
    eq([...src.matchAll(/rpc\(client, "([a-z_]+)"/g)].map((m) => m[1]), ["analytics_report", "analytics_reconcile", "analytics_diagnostics"]) &&
    !/\.from\(/.test(src) && src.includes("getAdminProducts(client"));
  t("no raw analytics table is read by any dashboard file", !/analytics_events|analytics_daily\b|analytics_daily_runs|analytics_job_log/.test(files.map(read).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  t("Today's raw read is bounded to today: diagnostics called with istDayStart(today) → now",
    read("components/admin/analytics/ShopAnalytics.tsx").includes("const todayFrom = istDayStart(today)") &&
    read("components/admin/analytics/ShopAnalytics.tsx").includes("source.diagnostics(todayFrom, todayTo)"));
  t("every call throws on error (no silent zeros)", src.includes("if (error) throw new Error(error.message)") && src.includes('onError: "throw"'));
  t("no new API route or server endpoint for analytics", !fs.existsSync("app/api/admin/analytics") && !fs.readdirSync("app/api").some((d) => /analytic|report|stats/i.test(d) && d !== "events"));
  t("no charting dependency added", !/recharts|chart\.js|chartjs|d3|nivo|victory|apexcharts|echarts|visx/i.test(read("package.json")));
  t("the page lives under the dashboard layout (middleware + DashboardChrome gate)",
    fs.existsSync("app/(admin)/admin/dashboard/analytics/page.tsx") && read("app/(admin)/admin/dashboard/layout.tsx").includes("DashboardChrome"));
  const page = read("app/(admin)/admin/dashboard/analytics/page.tsx");
  t("only a boolean about payments reaches the browser, never the key", page.includes('startsWith("rzp_live_")') && !/RAZORPAY_KEY_SECRET|key_id=/.test(page) && /paymentsLive=\{paymentsLive\}/.test(page));
  t("the order/stock dashboard is kept as its own view (revenue reported once)", read("components/admin/analytics/ShopAnalytics.tsx").includes("<AnalyticsDashboard />"));
  const ui = read("components/admin/analytics/ui.tsx");
  t("47. tables: caption, column and row headers, aria-sort", ui.includes("<caption") && ui.includes('scope="col"') && ui.includes('scope="row"') && ui.includes("aria-sort="));
  t("48. bars are decorative beside a table (aria-hidden); the trend chart has a table equivalent",
    ui.includes("<ul aria-hidden") && read("components/admin/analytics/OverviewViews.tsx").includes("Show as a table"));
  t("46. visible focus on every control", (ui.match(/focusRing/g) ?? []).length >= 4 && read("components/admin/analytics/ShopAnalytics.tsx").split("focusRing").length > 5);
  t("44. phones get cards, not a sideways-scrolling table", ui.includes('className="md:hidden"') && ui.includes('className="hidden md:block"') && !/overflow-x-(auto|scroll)/.test(ui));
  t("no colour-only meaning: change lines say Up/Down in words", read("lib/analyticsDashboard.ts").includes('`${c.pct > 0 ? "Up" : "Down"}'));
  t("27. no city or exact location anywhere", !/\bcity\b|latitude|longitude/i.test(visible.replace(/City and exact location are never recorded/g, "")));
  t("animations respect reduced motion", ui.includes("motion-reduce:animate-none"));
  t("purchases note follows the payment mode", read("components/admin/analytics/OverviewViews.tsx").includes("Card payments are still in test mode"));
  void all;
}

// ── Database, end to end ────────────────────────

type Row = Record<string, unknown>;

async function database(c: Client) {
  await asRoot(c);
  const q = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows as Row[];
  const one = async (sql: string, args: unknown[] = []) => (await q(sql, args))[0];
  const today = (await one("select analytics_day_of(now())::text d")).d as string;
  const day = (n: number) => addDays(today, n);

  const cat = (await one("insert into categories (name, slug) values ('Sarees', 'dash-sarees') returning id")).id as string;
  const product = async (name: string, slug: string) =>
    (await one("insert into products (name, slug, price_inr, category_id) values ($1, $2, 1000, $3) returning id", [name, slug, cat])).id as string;
  const P1 = await product("Kasavu Saree", "dash-kasavu");
  const P2 = await product("Set Mundu", "dash-mundu");
  const P3 = await product("Old Shawl", "dash-shawl");
  const P4 = await product("Gone Stole", "dash-stole");
  const admin = await makeAdmin(c, "staff@thewovenne.test");
  const cust = (await one("insert into auth.users (email) values ('asha@example.test') returning id")).id as string;
  await q("insert into profiles (id, email) values ($1, 'asha@example.test') on conflict do nothing", [cust]);
  const order = async (items: unknown[]) =>
    (await one("insert into orders (customer_email, total_inr, payment_status, payment_method, items) values ('asha@example.test', 3000, 'paid', 'razorpay', $1::jsonb) returning id",
      [JSON.stringify(items)])).id as string;

  type Ev = { type: string; at?: string; product?: string | null; source?: string | null; medium?: string | null; host?: string | null; campaign?: string | null;
    device?: string | null; country?: string | null; region?: string | null; term?: string | null; results?: number | null; qty?: number | null; traffic?: string; order?: string | null; entry?: boolean };
  const ev = async (d: string, e: Ev) => {
    await asRoot(c);
    await q(`insert into analytics_events (event_type, occurred_at, product_id, category_id, path, is_entry, source, medium, referrer_host, utm_campaign,
               device, country_code, region, search_term, result_count, quantity, traffic, order_id)
             values ($1, ($2::date + $3::time)::timestamp at time zone 'Asia/Kolkata', $4, $5, '/in/x', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [e.type, d, e.at ?? "12:00", e.product ?? null, e.product ? cat : null, e.entry ?? false, e.source ?? null, e.medium ?? null, e.host ?? null, e.campaign ?? null,
       e.device === undefined ? "mobile" : e.device, e.country === undefined ? "IN" : e.country, e.region === undefined ? "KL" : e.region,
       e.term ?? null, e.results ?? null, e.qty ?? null, e.traffic ?? "customer", e.order ?? null]);
  };
  const many = async (d: string, n: number, e: Ev) => { for (let i = 0; i < n; i++) await ev(d, e); };

  // Previous period: day(-5), day(-4). Current period: day(-3), day(-2).
  await many(day(-5), 2, { type: "page_view", source: "direct", medium: "none" });
  await many(day(-4), 2, { type: "product_view", product: P1 });
  // Current: day(-3)
  await ev(day(-3), { type: "page_view", source: "direct", medium: "none", device: "desktop", country: "GB", region: "ENG", entry: true });
  await ev(day(-3), { type: "page_view", source: null, device: null, country: null, region: null }); // unknown everything
  await ev(day(-3), { type: "page_view", source: "google", medium: "organic", host: "www.google.com", device: "tablet", region: "KA" });
  await ev(day(-3), { type: "page_view", source: "instagram", medium: "social", host: "l.instagram.com", campaign: "onam_2026", at: "23:59" });
  await ev(day(-2), { type: "page_view", source: "chatgpt", medium: "referral", host: "chatgpt.com", at: "00:01" });
  await many(day(-3), 3, { type: "product_view", product: P1, source: "instagram", medium: "social", campaign: "onam_2026" });
  await ev(day(-3), { type: "product_view", product: P2 });
  await ev(day(-3), { type: "product_view", product: P3 });
  await ev(day(-3), { type: "product_view", product: P4 });
  await ev(day(-3), { type: "wishlist_add", product: P1 });
  await ev(day(-3), { type: "cart_add", product: P1, qty: 2 });
  await ev(day(-2), { type: "checkout_start" });
  await ev(day(-2), { type: "checkout_start" }); // two checkouts for one cart add: later step > earlier
  await ev(day(-2), { type: "search", term: "kasavu", results: 4 });
  await ev(day(-2), { type: "search", term: "linen shirt", results: 0 });
  await ev(day(-2), { type: "search", term: "linen shirt", results: 0 });
  await ev(day(-2), { type: "search", term: "(redacted)", results: 0 });
  await ev(day(-2), { type: "whatsapp_click" });
  const O1 = await order([{ id: P1, name: "Kasavu Saree", quantity: 2, price_inr: 1000 }]);
  await ev(day(-2), { type: "purchase", order: O1, device: null, country: null, region: null });
  // Staff and test traffic on the same days — must never reach a figure.
  await many(day(-3), 7, { type: "page_view", traffic: "internal" });
  await many(day(-3), 2, { type: "product_view", product: P1, traffic: "internal" });
  await many(day(-2), 3, { type: "search", term: "staff test", results: 0, traffic: "internal" });
  const OT = await order([{ id: P2, name: "Set Mundu", quantity: 1, price_inr: 1000 }]);
  await ev(day(-2), { type: "purchase", order: OT, traffic: "test", device: null, country: null, region: null });
  // Today (not rolled up): customer + internal.
  await asRoot(c);
  await q("insert into analytics_events (event_type, occurred_at, path, traffic) values ('page_view', now(), '/in', 'customer'), ('page_view', now(), '/in', 'customer'), ('page_view', now(), '/in', 'internal')");

  // P4 is deleted BEFORE its day is rolled up (its raw rows lose the id).
  await q("delete from products where id = $1", [P4]);
  for (const d of [day(-6), day(-5), day(-4), day(-3), day(-2), day(-1)]) await one("select analytics_rollup_day($1::date)", [d]);
  // After rollup: P1 renamed, P3 deleted (its aggregate keeps the name it had).
  await q("update products set name = 'Kasavu Saree — Gold Border' where id = $1", [P1]);
  await q("delete from products where id = $1", [P3]);

  // The dashboard's calls, made as the admin through the API role — identical
  // function names and arguments to lib/analyticsDashboardSource.
  const as = async () => { await asRoot(c); await asAdmin(c, admin); };
  const report = async <R,>(from: string, to: string, grain: string) => { await as(); return (await one("select analytics_report($1::date, $2::date, $3) r", [from, to, grain])).r as Report<R>; };
  const reconcile = async (d: string) => { await as(); return (await one("select analytics_reconcile($1::date) r", [d])).r as Reconcile; };
  const diagnostics = async (from: Date, to: Date) => { await as(); return (await one("select analytics_diagnostics($1::timestamptz, $2::timestamptz) r", [from.toISOString(), to.toISOString()])).r as Diagnostics; };

  console.log("\nend to end: overview, comparison, funnel");
  const cur = await report<TotalRow>(day(-3), day(-2), "total");
  const prv = await report<TotalRow>(day(-5), day(-4), "total");
  const T = totalsFromReport(cur.rows);
  const Tp = totalsFromReport(prv.rows);
  t("2/41/42. customer totals only — staff and test excluded",
    T.page_view.events === 5 && T.product_view.events === 6 && T.search.events === 4 && T.purchase.events === 1 && T.purchase.units === 2,
    JSON.stringify({ pv: T.page_view.events, prv: T.product_view.events, s: T.search.events, p: T.purchase.events }));
  t("43. customer events are included (cart, wishlist, checkout, whatsapp)", T.cart_add.events === 1 && T.cart_add.units === 2 && T.wishlist_add.events === 1 && T.checkout_start.events === 2 && T.whatsapp_click.events === 1);
  t("4. comparison against the previous 2 days", coverageOf(prv) === "complete" &&
    describeChange(compare(T.page_view.events, Tp.page_view.events), "the previous 2 days").text === "Up 150% vs the previous 2 days (was 2)" &&
    describeChange(compare(T.product_view.events, Tp.product_view.events), "x").text.startsWith("Up 200%"));
  t("5. previous period zero → New", compare(T.search.events, Tp.search.events).kind === "new");
  const s = dailySeries(cur, "page_view");
  t("6. IST boundary: 23:59 IST counts on its day, 00:01 IST on the next", eq(s, [{ day: day(-3), value: 4 }, { day: day(-2), value: 1 }]));
  const F = funnel(T);
  t("9. funnel: checkout starts (2) exceed cart adds (1) and are shown as 200 per 100", F[2].events === 2 && F[2].ratio === 200 && F[2].exceedsPrevious);
  t("8. funnel: cart adds per 100 product views", Math.round(F[1].ratio! * 10) === 167);
  const before = await report<TotalRow>(day(-40), day(-39), "total");
  t("1. a period before collection: no coverage → unknown, not zero", coverageOf(before) === "none" && before.rows.length === 0 && describeGaps(before)!.includes("None of these days"));
  const mixed = await report<TotalRow>(day(-8), day(-2), "total");
  t("3. a multi-day range starting before data says where figures start", coverageOf(mixed) === "partial" && describeGaps(mixed)!.includes(`figures start on`), describeGaps(mixed) ?? "");
  const zero = await report<TotalRow>(day(-1), day(-1), "total");
  t("1. a processed day with no customer events is a real zero", coverageOf(zero) === "complete" && totalsFromReport(zero.rows).page_view.events === 0);

  console.log("\nend to end: products");
  const prod = await report<GrainRow>(day(-3), day(-2), "product");
  const meta = new Map<string, ProductMeta>([[P1, { id: P1, name: "Kasavu Saree — Gold Border", category: "Sarees", status: "live" }], [P2, { id: P2, name: "Set Mundu", category: "Sarees", status: "hidden" }]]);
  const pl = productLines(prod.rows, meta);
  const p1 = pl.find((l) => l.productId === P1)!;
  t("15. renamed product shows its current name with full history", p1.name === "Kasavu Saree — Gold Border" && p1.views === 3 && p1.cartAdds === 1 && p1.wishlistAdds === 1 && p1.purchases === 1 && p1.unitsSold === 2);
  t("16. hidden product still listed with its views", pl.find((l) => l.productId === P2)?.status === "hidden" && pl.find((l) => l.productId === P2)?.views === 1);
  t("17. deleted after rollup: stored name, marked deleted", pl.find((l) => l.productId === P3)?.name === "Old Shawl" && pl.find((l) => l.productId === P3)?.status === "deleted");
  t("17. deleted before rollup: kept as an unnamed deleted line", pl.find((l) => l.productId === null)?.name === DELETED_UNNAMED && pl.find((l) => l.productId === null)?.views === 1);
  t("41. staff product views are not in the product table", pl.reduce((n, l) => n + l.views, 0) === 6);
  t("42. the test purchase of Set Mundu is not counted", pl.find((l) => l.productId === P2)?.purchases === 0);

  console.log("\nend to end: sources, geography, devices, search");
  const src = sourceLines((await report<GrainRow>(day(-3), day(-2), "source")).rows);
  t("19/20/21/23. direct, unknown, google, chatgpt observed; no unobserved AI assistant",
    ["Direct", "Unknown", "Google", "ChatGPT", "Instagram"].every((l) => src.some((x) => x.label === l)) && !src.some((x) => /Claude|Gemini|Perplexity/.test(x.label)));
  t("20. source lines sum to the page-view total (unknown not redistributed)", src.reduce((n, l) => n + l.counts.page_view, 0) === T.page_view.events);
  const camp = campaignLines((await report<GrainRow>(day(-3), day(-2), "source")).rows);
  t("22. UTM campaign with its page and product views", camp.length === 1 && camp[0].label === "onam_2026" && camp[0].counts.page_view === 1 && camp[0].counts.product_view === 3);
  const loc = (await report<GrainRow>(day(-3), day(-2), "location")).rows;
  const countries = countryLines(loc);
  const regions = regionLines(loc);
  t("24/25. India/Kerala and United Kingdom/England from real rows", countries.some((l) => l.label === "India") && countries.some((l) => l.label === "United Kingdom") &&
    regions.some((l) => l.label === "Kerala") && regions.some((l) => l.label === "England" && l.detail === "United Kingdom") && regions.some((l) => l.label === "Karnataka"));
  t("26. unknown location visible", countries.some((l) => l.unknown && l.counts.page_view === 1));
  t("27. no city or coordinates in any location row", loc.every((r) => Object.keys(r).every((k) => !/city|lat|lon|ip/i.test(k))));
  const dev = deviceLines((await report<GrainRow>(day(-3), day(-2), "device")).rows);
  t("28–31. mobile, desktop, tablet, unknown from real rows", ["Mobile", "Desktop", "Tablet", "Unknown"].every((l) => dev.some((x) => x.label === l)));
  const sr = searchLines((await report<GrainRow>(day(-3), day(-2), "search")).rows);
  t("32/33. searches and zero-result searches", sr[0].term === "linen shirt" && sr[0].zeroResults === 2 && sr[0].zeroRate === 100 && sr.find((l) => l.term === "kasavu")?.zeroResults === 0);
  t("34. (redacted) stays redacted", sr.some((l) => l.redacted && l.term === "(redacted)"));
  t("41. staff searches are not in the search report", !sr.some((l) => l.term === "staff test"));
  t("35. empty search report for a quiet day", searchLines((await report<GrainRow>(day(-1), day(-1), "search")).rows).length === 0);

  console.log("\nend to end: today, freshness, health");
  const d = await diagnostics(istDayStart(today), new Date(Date.now() + 1000));
  t("today: live customer count (2), staff kept apart (1)", totalsFromDiagnostics(d).page_view.events === 2 && classesFromDiagnostics(d).internal === 1 && d.collecting === false);
  const cov = await report<TotalRow>(day(-35), day(-1), "total");
  const rec = await reconcile(latestCoveredDay(cov)!);
  const h = healthFrom({ diagnostics: d, coverage: cov, reconcile: rec });
  t("7. data through yesterday; reconciliation matches", h.dataThrough === day(-1) && h.reconciled === true && h.reconciledDay === day(-1));
  t("health reports the switch being off as the problem", h.collecting === false && !!h.problem?.includes("switched off"));
  const rec3 = await reconcile(day(-3));
  t("staff traffic counted on the status panel only", rec3.raw_at_rollup?.internal === 9 && rec3.raw_at_rollup?.customer === 12 && rec3.all_match === true,
    JSON.stringify(rec3.raw_at_rollup));

  console.log("\naccess (every call the dashboard makes)");
  const calls: [string, string, unknown[]][] = [
    ...["total", "product", "location", "device", "source", "search"].map((g) => [`report ${g}`, "select analytics_report($1::date, $2::date, $3)", [day(-3), day(-2), g]] as [string, string, unknown[]]),
    ["reconcile", "select analytics_reconcile($1::date)", [day(-3)]],
    ["diagnostics", "select analytics_diagnostics($1::timestamptz, $2::timestamptz)", [istDayStart(today).toISOString(), new Date(Date.now() + 1000).toISOString()]],
  ];
  const tryAll = async () => { const out: string[] = []; for (const [, sql, a] of calls) out.push(await failure(() => c.query(sql, a))); return out; };
  await asRoot(c);
  await c.query("set role anon");
  t("36. anonymous: every dashboard call refused", (await tryAll()).every((m) => m.includes("permission denied")));
  await asRoot(c);
  await asUser(c, cust, "aal1");
  t("37. customer: every dashboard call refused", (await tryAll()).every((m) => m.includes("Only admins")));
  await asRoot(c);
  await asUser(c, cust, "aal2");
  t("37. customer with a second factor: still refused (not staff)", (await tryAll()).every((m) => m.includes("Only admins")));
  await asRoot(c);
  await asStaffPasswordOnly(c, admin);
  t("38. staff at aal1 (no second factor): every call refused", (await tryAll()).every((m) => m.includes("Only admins")));
  await asRoot(c);
  await asAdmin(c, admin);
  t("40. verified admin (aal2, live session): every call allowed", (await tryAll()).every((m) => m === ""));
  t("admin cannot read raw or aggregate tables directly", (await failure(() => c.query("select 1 from analytics_events limit 1"))).includes("permission denied") &&
    (await failure(() => c.query("select 1 from analytics_daily limit 1"))).includes("permission denied"));
  const claims = (await one("select current_setting('request.jwt.claims') c")).c as string;
  await c.query("reset role");
  await c.query("delete from auth.sessions where user_id = $1", [admin]);
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [admin, claims]);
  t("39. revoked admin session (same token): every call refused", (await tryAll()).every((m) => m.includes("Only admins")));
  await asRoot(c);
}

(async () => {
  pure();
  sources();
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (DB SKIPPED)\n`);
    process.exit(fail ? 1 : 2);
  }
  console.log(`\n(${engine.version.split(",")[0]})`);
  let c: Client | null = null;
  try {
    await engine.database("dash");
    c = await engine.connect("dash");
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

void path;

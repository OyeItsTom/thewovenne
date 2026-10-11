/**
 * Admin Analytics V1 (1C): what the dashboard shows, and exactly how each
 * figure is worked out from the 1B reporting layer. docs/analytics.md §10.
 *
 * PURE. No database handle and no React — every number and every sentence the
 * dashboard derives from a report is decided here, so the rules are tested
 * directly (scripts/analytics-dashboard.test.ts) rather than through a browser.
 *
 * ── WHERE THE NUMBERS COME FROM ──
 *   Finished IST days    analytics_report(from, to, grain) — the verified daily
 *                        aggregates. Never raw events.
 *   Today (in progress)  analytics_diagnostics(today 00:00 IST, now) — a live
 *                        count of today's customer events, by type only. Shown
 *                        ONLY when "Today" is chosen, labelled provisional, and
 *                        never added to a finished-day figure.
 *
 * ── COUNTS OF EVENTS, NOT PEOPLE ──
 * There is no visitor or session identifier (1A), so nothing here is, or is
 * labelled as, visitors, sessions, bounce or conversion. Ratios are "per 100"
 * event ratios with the denominators docs/analytics.md §9.5 fixes, and a later
 * funnel step may exceed an earlier one; nothing clamps it.
 */

// ── Shapes returned by the 1B functions ─────────

export const EVENT_TYPES = [
  "page_view",
  "product_view",
  "search",
  "wishlist_add",
  "wishlist_remove",
  "cart_add",
  "cart_remove",
  "checkout_start",
  "whatsapp_click",
  "purchase",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Grain = "total" | "product" | "location" | "device" | "source" | "search";

export interface TotalRow {
  day: string;
  event_type: EventType;
  events: number;
  units: number | null;
  entries: number;
}

/** A row of any non-total grain; only that grain's dimensions are present. */
export interface GrainRow {
  event_type: EventType;
  events: number;
  units: number | null;
  entries: number;
  unknown: boolean;
  product_id?: string;
  product_name?: string;
  product_exists?: boolean;
  country_code?: string;
  region?: string;
  device?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  referrer_host?: string;
  search_term?: string;
  zero_results?: boolean;
}

export interface Report<R = GrainRow> {
  from: string;
  to: string;
  grain: Grain;
  days: number;
  covered_days: number;
  missing_days: string[];
  rows: R[];
}

export interface ReconcileJob {
  ran_at: string;
  job: string;
  ok: boolean;
  error?: string | null;
  stage?: string | null;
}

export interface Reconcile {
  day: string;
  rolled_up: boolean;
  rolled_up_at: string | null;
  raw_at_rollup: { customer: number; internal: number; test: number } | null;
  raw_retained: boolean;
  all_match: boolean;
  last_jobs: ReconcileJob[];
}

export interface Diagnostics {
  collecting: boolean;
  collecting_changed_at: string | null;
  by_type: { event_type: EventType; traffic: "customer" | "internal" | "test"; events: number }[];
}

// ── IST days ────────────────────────────────────
// Asia/Kolkata is UTC+05:30 all year (no daylight saving), so a fixed offset
// is exact — and does not depend on the browser's time zone or Intl data.

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The IST calendar day an instant falls on, as YYYY-MM-DD. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant an IST day begins (00:00 IST = 18:30 UTC the day before). */
export function istDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive day count of [from, to]. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

export function isIsoDay(v: unknown): v is string {
  return typeof v === "string" && ISO_DAY.test(v) && istDay(new Date(Date.parse(`${v}T12:00:00Z`))) === v;
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const SHORT_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const IST_TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});

/** "12 Oct 2026" for an IST day. */
export function formatDay(day: string): string {
  return DATE_FMT.format(new Date(`${day}T00:00:00Z`));
}

/** "12 Oct" for chart labels. */
export function formatShortDay(day: string): string {
  return SHORT_FMT.format(new Date(`${day}T00:00:00Z`));
}

/** "12 Oct 2026, 2:00 am IST" for an instant. */
export function formatIstTime(iso: string): string {
  return `${IST_TIME_FMT.format(new Date(iso))} IST`;
}

// ── Date ranges ─────────────────────────────────

export type Preset = "today" | "yesterday" | "7d" | "30d" | "custom";
export const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "custom", label: "Custom" },
];

/** A custom range may cover at most this many days. */
export const MAX_CUSTOM_DAYS = 366;

export interface Range {
  preset: Preset;
  from: string;
  to: string;
  days: number;
  /**
   * True only for Today: the day has not finished, so it has no aggregate and
   * is read as a provisional live count.
   */
  live: boolean;
}

export type RangeResult = { ok: true; range: Range } | { ok: false; error: string };

/**
 * The days a choice covers. Every range except Today ends at YESTERDAY (IST):
 * "Last 7 days" is the last 7 finished days, so a final figure never includes
 * a day that is still in progress.
 */
export function resolveRange(preset: Preset, now: Date, custom?: { from?: string; to?: string }): RangeResult {
  const today = istDay(now);
  const yesterday = addDays(today, -1);
  const make = (from: string, to: string, live = false): RangeResult => ({
    ok: true,
    range: { preset, from, to, days: spanDays(from, to), live },
  });
  switch (preset) {
    case "today":
      return make(today, today, true);
    case "yesterday":
      return make(yesterday, yesterday);
    case "7d":
      return make(addDays(yesterday, -6), yesterday);
    case "30d":
      return make(addDays(yesterday, -29), yesterday);
    case "custom": {
      const from = custom?.from;
      const to = custom?.to;
      if (!isIsoDay(from) || !isIsoDay(to)) return { ok: false, error: "Choose a start and an end date." };
      if (to < from) return { ok: false, error: "The end date is before the start date." };
      if (to > yesterday) {
        return { ok: false, error: `Custom ranges end yesterday (${formatDay(yesterday)}) at the latest — today is still in progress.` };
      }
      if (spanDays(from, to) > MAX_CUSTOM_DAYS) return { ok: false, error: `Choose at most ${MAX_CUSTOM_DAYS} days.` };
      return make(from, to);
    }
  }
}

/**
 * The comparison period: the same number of days immediately before. None for
 * Today — a partial day is never compared with a finished one.
 */
export function previousRange(r: Range): { from: string; to: string } | null {
  if (r.live) return null;
  return { from: addDays(r.from, -r.days), to: addDays(r.from, -1) };
}

/** "the day before" / "the previous 7 days". */
export function previousLabel(r: Pick<Range, "days">): string {
  return r.days === 1 ? "the day before" : `the previous ${r.days} days`;
}

export function rangeLabel(r: Range): string {
  if (r.live) return `Today, ${formatDay(r.from)} — in progress`;
  if (r.from === r.to) return formatDay(r.from);
  return `${formatDay(r.from)} – ${formatDay(r.to)}`;
}

// ── Coverage ────────────────────────────────────

export type CoverageState = "complete" | "partial" | "none";

export function coverageOf(rep: Pick<Report, "days" | "covered_days">): CoverageState {
  if (rep.covered_days >= rep.days) return "complete";
  return rep.covered_days === 0 ? "none" : "partial";
}

/**
 * A plain sentence for days in a range that have no figures — which are
 * UNKNOWN, not zero. Days before the first covered day are usually before
 * collection began; a gap after one means the day is not processed yet.
 */
export function describeGaps(rep: Pick<Report, "from" | "to" | "days" | "covered_days" | "missing_days">): string | null {
  const state = coverageOf(rep);
  if (state === "complete") return null;
  if (state === "none") {
    return rep.days === 1
      ? "This day has not been processed yet. Finished days are processed at 2:00 am IST."
      : "None of these days has been processed — they are before collection began, or not processed yet.";
  }
  const missing = [...rep.missing_days].sort();
  let leading = 0;
  for (let d = rep.from; missing[leading] === d; d = addDays(d, 1)) leading++;
  const rest = missing.length - leading;
  const parts: string[] = [];
  if (leading > 0) {
    parts.push(
      `figures start on ${formatDay(addDays(rep.from, leading))} — the ${leading} day${leading === 1 ? "" : "s"} before that ${leading === 1 ? "has" : "have"} no data`
    );
  }
  if (rest > 0) parts.push(`${rest} later day${rest === 1 ? " is" : "s are"} not processed yet`);
  const sentence = parts.join("; ");
  return `Covers ${rep.covered_days} of ${rep.days} days: ${sentence}.`;
}

// ── Totals ──────────────────────────────────────

export type Totals = Record<EventType, { events: number; units: number }>;

export function emptyTotals(): Totals {
  return Object.fromEntries(EVENT_TYPES.map((t) => [t, { events: 0, units: 0 }])) as Totals;
}

export function totalsFromReport(rows: readonly TotalRow[]): Totals {
  const out = emptyTotals();
  for (const r of rows) {
    if (!out[r.event_type]) continue;
    out[r.event_type].events += Number(r.events) || 0;
    out[r.event_type].units += Number(r.units) || 0;
  }
  return out;
}

/** Today's provisional customer counts. Internal and test are never included. */
export function totalsFromDiagnostics(d: Pick<Diagnostics, "by_type">): Totals {
  const out = emptyTotals();
  for (const r of d.by_type) {
    if (r.traffic !== "customer" || !out[r.event_type]) continue;
    out[r.event_type].events += Number(r.events) || 0;
  }
  return out;
}

export interface TrafficClasses {
  customer: number;
  internal: number;
  test: number;
}

export function classesFromDiagnostics(d: Pick<Diagnostics, "by_type">): TrafficClasses {
  const out = { customer: 0, internal: 0, test: 0 };
  for (const r of d.by_type) if (r.traffic in out) out[r.traffic] += Number(r.events) || 0;
  return out;
}

/**
 * One value per COVERED day, oldest first. Days with no rollup are left out
 * (unknown, not zero) — the chart says how many are missing.
 */
export function dailySeries(rep: Report<TotalRow>, type: EventType): { day: string; value: number }[] {
  const missing = new Set(rep.missing_days);
  const byDay = new Map<string, number>();
  for (const r of rep.rows) if (r.event_type === type) byDay.set(r.day, (byDay.get(r.day) ?? 0) + Number(r.events));
  const out: { day: string; value: number }[] = [];
  for (let d = rep.from; d <= rep.to; d = addDays(d, 1)) {
    if (!missing.has(d)) out.push({ day: d, value: byDay.get(d) ?? 0 });
  }
  return out;
}

// ── Overview metrics and comparison ─────────────

export const OVERVIEW_METRICS: { type: EventType; label: string }[] = [
  { type: "page_view", label: "Page views" },
  { type: "product_view", label: "Product views" },
  { type: "search", label: "Searches" },
  { type: "wishlist_add", label: "Wishlist adds" },
  { type: "cart_add", label: "Cart adds" },
  { type: "checkout_start", label: "Checkout starts" },
  { type: "purchase", label: "Purchases" },
  { type: "whatsapp_click", label: "WhatsApp clicks" },
];

export type Change =
  | { kind: "pct"; pct: number; prev: number }
  | { kind: "new" }
  | { kind: "none" }
  | { kind: "unavailable" };

/**
 * Change against the previous period. `prev` is null when that period is not
 * fully processed — then there is no honest comparison to make.
 *   previous 0, now 0  → none ("—")
 *   previous 0, now >0 → new (never an infinite percentage)
 */
export function compare(cur: number, prev: number | null): Change {
  if (prev === null) return { kind: "unavailable" };
  if (prev === 0) return cur === 0 ? { kind: "none" } : { kind: "new" };
  return { kind: "pct", pct: ((cur - prev) / prev) * 100, prev };
}

export interface ChangeText {
  text: string;
  /** For an arrow glyph; the text always says the direction in words too. */
  direction: "up" | "down" | "same" | null;
}

/** `prev` is previousLabel(range): "the day before" / "the previous 7 days". */
export function describeChange(c: Change, prev: string): ChangeText {
  const vs = `vs ${prev}`;
  switch (c.kind) {
    case "unavailable":
      return { text: "— no comparison: the previous period isn't fully processed", direction: null };
    case "none":
      return { text: "— none in either period", direction: null };
    case "new":
      return { text: `New — none ${prev.startsWith("the day") ? "on" : "in"} ${prev}`, direction: "up" };
    case "pct": {
      const abs = Math.abs(c.pct);
      if (abs === 0) return { text: `No change ${vs} (${c.prev.toLocaleString("en-IN")})`, direction: "same" };
      const shown = abs < 1 ? "<1" : String(Math.round(abs));
      return {
        text: `${c.pct > 0 ? "Up" : "Down"} ${shown}% ${vs} (was ${c.prev.toLocaleString("en-IN")})`,
        direction: c.pct > 0 ? "up" : "down",
      };
    }
  }
}

// ── Funnel (an EVENT funnel) ────────────────────

export const FUNNEL_STEPS: { type: EventType; label: string; ratioLabel: string | null }[] = [
  { type: "product_view", label: "Product views", ratioLabel: null },
  { type: "cart_add", label: "Cart adds", ratioLabel: "cart adds per 100 product views" },
  { type: "checkout_start", label: "Checkout starts", ratioLabel: "checkout starts per 100 cart adds" },
  { type: "purchase", label: "Purchases", ratioLabel: "purchases per 100 checkout starts" },
];

/** 100 × n / d, or null when the denominator is zero (never Infinity or NaN). */
export function per100(n: number, d: number): number | null {
  if (!(d > 0)) return null;
  return (n * 100) / d;
}

export function formatPer100(v: number | null): string {
  if (v === null) return "—";
  if (v >= 10) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toString();
}

export interface FunnelStep {
  type: EventType;
  label: string;
  events: number;
  /** Ratio to the step before; null for the first step or a zero denominator. */
  ratio: number | null;
  ratioLabel: string | null;
  /** True when this step has more events than the one before — shown as is. */
  exceedsPrevious: boolean;
}

export function funnel(t: Totals): FunnelStep[] {
  return FUNNEL_STEPS.map((s, i) => {
    const events = t[s.type].events;
    const prev = i === 0 ? null : t[FUNNEL_STEPS[i - 1].type].events;
    return {
      type: s.type,
      label: s.label,
      events,
      ratio: prev === null ? null : per100(events, prev),
      ratioLabel: s.ratioLabel,
      exceedsPrevious: prev !== null && events > prev,
    };
  });
}

// ── Products ────────────────────────────────────

export type ProductStatus = "live" | "hidden" | "never-published" | "deleted";

export const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  live: "Live",
  hidden: "Hidden",
  "never-published": "Never published",
  deleted: "Deleted",
};

/** What the admin product list knows about a product today. */
export interface ProductMeta {
  id: string;
  name: string;
  category: string | null;
  status: Exclude<ProductStatus, "deleted">;
}

/** Where a product stands today, from the admin product list's facts. */
export function metaFromProduct(p: {
  id: string;
  name: string;
  category?: string | null;
  publication?: { hasPublished: boolean; liveVisible: boolean };
}): ProductMeta {
  return {
    id: p.id,
    name: p.name,
    category: p.category ?? null,
    status: !p.publication?.hasPublished ? "never-published" : p.publication.liveVisible ? "live" : "hidden",
  };
}

export interface ProductLine {
  key: string;
  productId: string | null;
  name: string;
  category: string | null;
  /** null = the product exists but its current state could not be read. */
  status: ProductStatus | null;
  views: number;
  wishlistAdds: number;
  cartAdds: number;
  /** Orders containing the product (purchase.events in the product grain). */
  purchases: number;
  unitsSold: number;
  cartPer100Views: number | null;
}

export const DELETED_UNNAMED = "Deleted product (name not kept)";

/**
 * One line per product from the product grain. The report already names a
 * product by its CURRENT name while it exists and by the name it had at rollup
 * once deleted (§9.7). A row with no product id at all is history whose
 * product was deleted before the day was rolled up; it is kept, not dropped.
 */
export function productLines(
  rows: readonly GrainRow[],
  meta: ReadonlyMap<string, ProductMeta> | null,
  opts: { includeInactive?: boolean } = {}
): ProductLine[] {
  const lines = new Map<string, ProductLine>();
  const line = (r: Pick<GrainRow, "product_id" | "product_name" | "product_exists">): ProductLine => {
    const key = r.product_id ?? `deleted:${r.product_name ?? ""}`;
    let l = lines.get(key);
    if (!l) {
      const m = r.product_id ? meta?.get(r.product_id) : undefined;
      const deleted = !r.product_id || r.product_exists === false;
      l = {
        key,
        productId: r.product_id ?? null,
        name: r.product_name || (deleted ? DELETED_UNNAMED : m?.name ?? "Unnamed product"),
        category: deleted ? null : m?.category ?? null,
        status: deleted ? "deleted" : m?.status ?? null,
        views: 0,
        wishlistAdds: 0,
        cartAdds: 0,
        purchases: 0,
        unitsSold: 0,
        cartPer100Views: null,
      };
      lines.set(key, l);
    }
    return l;
  };
  for (const r of rows) {
    const l = line(r);
    const n = Number(r.events) || 0;
    if (r.event_type === "product_view") l.views += n;
    else if (r.event_type === "wishlist_add") l.wishlistAdds += n;
    else if (r.event_type === "cart_add") l.cartAdds += n;
    else if (r.event_type === "purchase") {
      l.purchases += n;
      l.unitsSold += Number(r.units) || 0;
    }
  }
  if (opts.includeInactive && meta) {
    for (const m of meta.values()) {
      if (!lines.has(m.id)) line({ product_id: m.id, product_name: m.name, product_exists: true });
    }
  }
  const out = [...lines.values()];
  for (const l of out) l.cartPer100Views = per100(l.cartAdds, l.views);
  return out;
}

// ── Sources, campaigns, referrers ───────────────

/**
 * Display names for the sources the collector assigns (attributionFor). A
 * name appears only when a row carries it: nothing is listed, and no AI
 * assistant is shown, unless traffic from it was actually observed. Anything
 * else (a utm_source label) is shown exactly as received.
 */
export const SOURCE_LABELS: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  yahoo: "Yahoo",
  ecosia: "Ecosia",
  instagram: "Instagram",
  facebook: "Facebook",
  meta: "Meta (Facebook / Instagram)",
  whatsapp: "WhatsApp",
  youtube: "YouTube",
  pinterest: "Pinterest",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
  copilot: "Copilot",
  email: "Email",
  direct: "Direct",
  other: "Other websites",
};

export const UNKNOWN = "Unknown";

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return UNKNOWN;
  return SOURCE_LABELS[source] ?? source;
}

/** The four browser activities every breakdown reports. */
export const ACTIVITY: { type: EventType; label: string }[] = [
  { type: "page_view", label: "Page views" },
  { type: "product_view", label: "Product views" },
  { type: "cart_add", label: "Cart adds" },
  { type: "checkout_start", label: "Checkout starts" },
];

export interface DimensionLine {
  key: string;
  label: string;
  /** Secondary text, e.g. the country of a region. */
  detail?: string;
  unknown: boolean;
  counts: Record<EventType, number>;
}

function zeroCounts(): Record<EventType, number> {
  return Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<EventType, number>;
}

/**
 * Sum a grain's rows by a dimension. Rows whose key is null are kept as their
 * own line (Unknown) — never dropped and never spread over the others.
 */
export function groupBy(
  rows: readonly GrainRow[],
  keyOf: (r: GrainRow) => string | null,
  labelOf: (r: GrainRow, key: string | null) => { label: string; detail?: string; unknown: boolean }
): DimensionLine[] {
  const lines = new Map<string, DimensionLine>();
  for (const r of rows) {
    const k = keyOf(r);
    const key = k ?? "\u0000unknown";
    let l = lines.get(key);
    if (!l) {
      l = { key, ...labelOf(r, k), counts: zeroCounts() };
      lines.set(key, l);
    }
    l.counts[r.event_type] += Number(r.events) || 0;
  }
  return [...lines.values()].sort(
    (a, b) => b.counts.page_view - a.counts.page_view || b.counts.product_view - a.counts.product_view || a.label.localeCompare(b.label)
  );
}

export function sourceLines(rows: readonly GrainRow[]): DimensionLine[] {
  return groupBy(rows, (r) => r.source ?? null, (_r, k) => ({ label: sourceLabel(k), unknown: k === null }));
}

/** Only rows that carried a utm_campaign; empty when no tagged links were used. */
export function campaignLines(rows: readonly GrainRow[]): DimensionLine[] {
  return groupBy(
    rows.filter((r) => r.campaign),
    (r) => `${r.source ?? ""}\u0001${r.medium ?? ""}\u0001${r.campaign}`,
    (r) => ({ label: r.campaign!, detail: `${sourceLabel(r.source)} / ${r.medium ?? "(no medium)"}`, unknown: false })
  );
}

/** Referring websites (host only), for rows that had one. */
export function referrerLines(rows: readonly GrainRow[]): DimensionLine[] {
  return groupBy(
    rows.filter((r) => r.referrer_host),
    (r) => r.referrer_host!,
    (r) => ({ label: r.referrer_host!, detail: sourceLabel(r.source), unknown: false })
  );
}

// ── Geography ───────────────────────────────────
// Country names from the browser's own ISO list; first-level region names for
// the countries Wovenne mostly hears from. Any other code is shown as the code.

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string | null | undefined): string {
  if (!code) return UNKNOWN;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** ISO 3166-2 subdivision names, without the country prefix (as Vercel sends them). */
export const REGION_NAMES: Record<string, Record<string, string>> = {
  IN: {
    AN: "Andaman and Nicobar Islands", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam",
    BR: "Bihar", CH: "Chandigarh", CT: "Chhattisgarh", CG: "Chhattisgarh",
    DH: "Dadra and Nagar Haveli and Daman and Diu", DN: "Dadra and Nagar Haveli", DD: "Daman and Diu",
    DL: "Delhi", GA: "Goa", GJ: "Gujarat", HR: "Haryana", HP: "Himachal Pradesh", JK: "Jammu and Kashmir",
    JH: "Jharkhand", KA: "Karnataka", KL: "Kerala", LA: "Ladakh", LD: "Lakshadweep", MP: "Madhya Pradesh",
    MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya", MZ: "Mizoram", NL: "Nagaland", OR: "Odisha",
    OD: "Odisha", PY: "Puducherry", PB: "Punjab", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu",
    TG: "Telangana", TS: "Telangana", TR: "Tripura", UP: "Uttar Pradesh", UT: "Uttarakhand",
    UK: "Uttarakhand", WB: "West Bengal",
  },
  GB: { ENG: "England", SCT: "Scotland", WLS: "Wales", NIR: "Northern Ireland" },
  AE: {
    AZ: "Abu Dhabi", DU: "Dubai", SH: "Sharjah", AJ: "Ajman", UQ: "Umm Al Quwain",
    RK: "Ras Al Khaimah", FU: "Fujairah",
  },
  US: {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
    LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
    NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
    OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
    SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  },
};

export function regionName(country: string | null | undefined, region: string | null | undefined): string {
  if (!region) return "Unknown region";
  return (country && REGION_NAMES[country]?.[region]) || `Region ${region}`;
}

export function countryLines(rows: readonly GrainRow[]): DimensionLine[] {
  return groupBy(rows, (r) => r.country_code ?? null, (_r, k) => ({ label: countryName(k), unknown: k === null }));
}

/** Regions within known countries. Unknown-country rows stay in the country table. */
export function regionLines(rows: readonly GrainRow[]): DimensionLine[] {
  return groupBy(
    rows.filter((r) => r.country_code),
    (r) => `${r.country_code}\u0001${r.region ?? ""}`,
    (r) => ({ label: regionName(r.country_code, r.region), detail: countryName(r.country_code), unknown: !r.region })
  );
}

// ── Devices ─────────────────────────────────────

export const DEVICE_LABELS: Record<string, string> = { mobile: "Mobile", desktop: "Desktop", tablet: "Tablet" };

export function deviceLines(rows: readonly GrainRow[]): DimensionLine[] {
  return groupBy(rows, (r) => r.device ?? null, (_r, k) => ({ label: k ? DEVICE_LABELS[k] ?? k : UNKNOWN, unknown: k === null }));
}

// ── Search ──────────────────────────────────────

export const REDACTED = "(redacted)";

export interface SearchLine {
  term: string;
  redacted: boolean;
  searches: number;
  /** Searches that found nothing. */
  zeroResults: number;
  /** Searches whose result count was captured — the zero-result denominator. */
  known: number;
  /** % of known-result searches that found nothing; null with no known count. */
  zeroRate: number | null;
}

export function searchLines(rows: readonly GrainRow[]): SearchLine[] {
  const lines = new Map<string, SearchLine>();
  for (const r of rows) {
    if (r.event_type !== "search" || !r.search_term) continue;
    let l = lines.get(r.search_term);
    if (!l) {
      l = { term: r.search_term, redacted: r.search_term === REDACTED, searches: 0, zeroResults: 0, known: 0, zeroRate: null };
      lines.set(r.search_term, l);
    }
    const n = Number(r.events) || 0;
    l.searches += n;
    if (r.zero_results === true) l.zeroResults += n;
    if (r.zero_results === true || r.zero_results === false) l.known += n;
  }
  const out = [...lines.values()];
  for (const l of out) l.zeroRate = per100(l.zeroResults, l.known);
  return out.sort((a, b) => b.searches - a.searches || a.term.localeCompare(b.term));
}

/** Terms that found nothing at least once, most-missed first. */
export function zeroResultLines(lines: readonly SearchLine[]): SearchLine[] {
  return lines.filter((l) => l.zeroResults > 0).sort((a, b) => b.zeroResults - a.zeroResults || a.term.localeCompare(b.term));
}

// ── Freshness and health ────────────────────────

/** The latest covered day in a total report, or null if none is covered. */
export function latestCoveredDay(rep: Pick<Report, "from" | "to" | "missing_days">): string | null {
  const missing = new Set(rep.missing_days);
  for (let d = rep.to; d >= rep.from; d = addDays(d, -1)) if (!missing.has(d)) return d;
  return null;
}

export interface Health {
  collecting: boolean | null;
  collectingChangedAt: string | null;
  /** Finished figures run through the end of this IST day. */
  dataThrough: string | null;
  lastRun: ReconcileJob | null;
  lastSuccessfulRun: string | null;
  /** Reconciliation for the latest covered day. */
  reconciledDay: string | null;
  reconciled: boolean | null;
  classes: TrafficClasses | null;
  problem: string | null;
}

export function healthFrom(input: {
  diagnostics: Diagnostics | null;
  coverage: Pick<Report, "from" | "to" | "missing_days"> | null;
  reconcile: Reconcile | null;
}): Health {
  const jobs = (input.reconcile?.last_jobs ?? []).filter((j) => j.job === "nightly");
  const lastRun = jobs[0] ?? null;
  const ok = jobs.find((j) => j.ok);
  let problem: string | null = null;
  if (input.diagnostics && !input.diagnostics.collecting) problem = "Collection is switched off — no new events are being recorded.";
  else if (lastRun && !lastRun.ok) {
    problem = `The last nightly run failed${lastRun.stage ? ` at the ${lastRun.stage} step` : ""}${lastRun.stage === "rollup" ? "; raw events were kept and nothing was purged" : ""}.`;
  } else if (input.reconcile && input.reconcile.rolled_up && !input.reconcile.all_match) {
    problem = "The latest day's figures do not reconcile with its raw events.";
  }
  return {
    collecting: input.diagnostics ? input.diagnostics.collecting : null,
    collectingChangedAt: input.diagnostics?.collecting_changed_at ?? null,
    dataThrough: input.coverage ? latestCoveredDay(input.coverage) : null,
    lastRun,
    lastSuccessfulRun: ok?.ran_at ?? null,
    reconciledDay: input.reconcile?.rolled_up ? input.reconcile.day : null,
    reconciled: input.reconcile?.rolled_up ? input.reconcile.all_match : null,
    classes: input.reconcile?.raw_at_rollup ?? null,
    problem,
  };
}

// ── Sorting (tables) ────────────────────────────

export type SortDir = "asc" | "desc";

/** Stable sort by a column value; nulls always last, ties by label. */
export function sortRows<T>(rows: readonly T[], value: (r: T) => number | string | null, dir: SortDir, label: (r: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return label(a).localeCompare(label(b));
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "en", { sensitivity: "base", numeric: true });
    return (dir === "asc" ? c : -c) || label(a).localeCompare(label(b));
  });
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-IN");
}

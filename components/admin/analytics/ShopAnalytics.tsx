"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import AnalyticsDashboard from "@/components/admin/AnalyticsDashboard";
import { getBrowserSupabase } from "@/lib/supabase";
import { supabaseAnalyticsSource, type AnalyticsSource } from "@/lib/analyticsDashboardSource";
import {
  addDays,
  classesFromDiagnostics,
  coverageOf,
  describeGaps,
  formatDay,
  formatIstTime,
  healthFrom,
  istDay,
  istDayStart,
  isIsoDay,
  PRESETS,
  previousRange,
  rangeLabel,
  resolveRange,
  totalsFromDiagnostics,
  totalsFromReport,
  type Diagnostics,
  type Grain,
  type GrainRow,
  type Preset,
  type ProductMeta,
  type Range,
  type Reconcile,
  type Report,
  type TotalRow,
} from "@/lib/analyticsDashboard";
import { Empty, Loading, LoadError, Note, Warning, focusRing } from "./ui";
import { FunnelView, HealthPanel, OverviewView } from "./OverviewViews";
import { DevicesView, GeographyView, ProductsView, SearchView, SourcesView } from "./BreakdownViews";

/**
 * Admin → Analytics.
 *
 * One section, eight views. The first seven are the shop-activity figures
 * from Analytics 1B; the last is the original order and stock dashboard (0025)
 * unchanged, so revenue is reported in exactly one place.
 *
 * WHAT A RANGE MEANS (docs/analytics.md §10):
 *   Yesterday / 7 / 30 days / Custom — finished IST days only, ending yesterday
 *   at the latest, from the nightly aggregates. Days with no rollup are
 *   unknown, never zero, and are called out.
 *   Today — a provisional live count of today's customer events by type
 *   (Overview and Funnel only). It is never added to a finished-day figure, and
 *   the breakdowns say they arrive after the nightly run.
 *
 * Reads go through `source` (default: the signed-in admin's Supabase client),
 * so every figure is subject to the database's own admin gate.
 */

const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "funnel", label: "Funnel" },
  { id: "products", label: "Products" },
  { id: "sources", label: "Traffic sources" },
  { id: "geography", label: "Geography" },
  { id: "devices", label: "Devices" },
  { id: "search", label: "Search" },
  { id: "orders", label: "Orders & stock" },
] as const;
type View = (typeof VIEWS)[number]["id"];

const GRAIN_FOR: Partial<Record<View, Grain>> = {
  overview: "total",
  funnel: "total",
  products: "product",
  sources: "source",
  geography: "location",
  devices: "device",
  search: "search",
};

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: string };

/**
 * Load-once per key. Results are cached for the life of the page (until
 * Refresh), so switching views or going back to a range doesn't re-query.
 */
function useCached<T>(cache: Map<string, Promise<unknown>>, key: string | null, fn: () => Promise<T>): Load<T> & { retry: () => void } {
  const [state, setState] = useState<{ key: string | null; load: Load<T> }>({ key: null, load: { status: "loading" } });
  const [attempt, setAttempt] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!key) return;
    let live = true;
    let p = cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fnRef.current();
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    setState((s) => (s.key === key && s.load.status === "ready" ? s : { key, load: { status: "loading" } }));
    p.then(
      (data) => live && setState({ key, load: { status: "ready", data } }),
      (e: unknown) => live && setState({ key, load: { status: "error", error: e instanceof Error ? e.message : String(e) } })
    );
    return () => {
      live = false;
    };
  }, [cache, key, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const load: Load<T> = key && state.key === key ? state.load : { status: "loading" };
  return { ...load, retry };
}

function readUrl(): { view: View; preset: Preset; from?: string; to?: string } {
  const p = new URLSearchParams(window.location.search);
  const view = VIEWS.some((v) => v.id === p.get("view")) ? (p.get("view") as View) : "overview";
  const preset = PRESETS.some((x) => x.id === p.get("range")) ? (p.get("range") as Preset) : "7d";
  const from = p.get("from") ?? undefined;
  const to = p.get("to") ?? undefined;
  return { view, preset, from: isIsoDay(from) ? from : undefined, to: isIsoDay(to) ? to : undefined };
}

function hrefFor(view: View, preset: Preset, custom: { from?: string; to?: string }): string {
  const p = new URLSearchParams({ view, range: preset });
  if (preset === "custom" && custom.from && custom.to) {
    p.set("from", custom.from);
    p.set("to", custom.to);
  }
  return `?${p.toString()}`;
}

export default function ShopAnalytics({
  paymentsLive,
  source: sourceIn,
  now: nowIn,
}: {
  /** Razorpay is on live keys — decided on the server; the key never reaches here. */
  paymentsLive: boolean;
  source?: AnalyticsSource;
  now?: () => Date;
}) {
  const source = useMemo(() => sourceIn ?? supabaseAnalyticsSource(getBrowserSupabase()), [sourceIn]);
  // Read through a ref: a caller passing a fresh function each render must not
  // re-run the mount effect.
  const nowRef = useRef(nowIn ?? (() => new Date()));
  nowRef.current = nowIn ?? nowRef.current;

  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [preset, setPreset] = useState<Preset>("7d");
  const [custom, setCustom] = useState<{ from?: string; to?: string }>({});
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [generation, setGeneration] = useState(0);
  const [cache] = useState(() => new Map<string, Promise<unknown>>());
  // "Now" is fixed until Refresh, so Today's window and the IST date do not
  // drift between renders.
  const [now, setNow] = useState(() => nowRef.current());

  useEffect(() => {
    const u = readUrl();
    setView(u.view);
    setPreset(u.preset);
    setCustom({ from: u.from, to: u.to });
    const y = addDays(istDay(nowRef.current()), -1);
    setDraft({ from: u.from ?? addDays(y, -6), to: u.to ?? y });
    setReady(true);
    const onPop = () => {
      const v = readUrl();
      setView(v.view);
      setPreset(v.preset);
      setCustom({ from: v.from, to: v.to });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (next: { view?: View; preset?: Preset; custom?: { from?: string; to?: string } }) => {
    const v = next.view ?? view;
    const p = next.preset ?? preset;
    const c = next.custom ?? custom;
    setView(v);
    setPreset(p);
    setCustom(c);
    window.history.pushState(null, "", hrefFor(v, p, c));
  };

  const resolved = resolveRange(preset, now, custom);
  const range: Range | null = resolved.ok ? resolved.range : null;
  const today = istDay(now);
  const yesterday = addDays(today, -1);
  const prev = range ? previousRange(range) : null;
  const grain = GRAIN_FOR[view];
  const g = `g${generation}`;

  // ── Status: switch + today's live count, freshness, the nightly job ──
  const todayFrom = istDayStart(today);
  const todayTo = new Date(Math.max(now.getTime(), todayFrom.getTime() + 1000));
  const diag = useCached<Diagnostics>(cache, ready ? `${g}:diag` : null, () => source.diagnostics(todayFrom, todayTo));
  const coverage = useCached<Report<TotalRow>>(cache, ready ? `${g}:cov` : null, () =>
    source.report<TotalRow>(addDays(yesterday, -34), yesterday, "total")
  );
  const latest = coverage.status === "ready" ? healthFrom({ diagnostics: null, coverage: coverage.data, reconcile: null }).dataThrough : null;
  const recon = useCached<Reconcile>(cache, ready && coverage.status !== "loading" ? `${g}:recon:${latest ?? yesterday}` : null, () =>
    source.reconcile(latest ?? yesterday)
  );
  const health =
    diag.status !== "loading" && coverage.status !== "loading" && recon.status !== "loading"
      ? healthFrom({
          diagnostics: diag.status === "ready" ? diag.data : null,
          coverage: coverage.status === "ready" ? coverage.data : null,
          reconcile: recon.status === "ready" ? recon.data : null,
        })
      : null;

  // ── The view's own data ──
  const wantsReport = ready && range && !range.live && grain && view !== "orders";
  const report = useCached<Report<GrainRow | TotalRow>>(
    cache,
    wantsReport ? `${g}:${grain}:${range!.from}:${range!.to}` : null,
    () => source.report(range!.from, range!.to, grain!)
  );
  const wantsPrev = ready && view === "overview" && range && prev;
  const prevReport = useCached<Report<TotalRow>>(cache, wantsPrev ? `${g}:total:${prev!.from}:${prev!.to}` : null, () =>
    source.report<TotalRow>(prev!.from, prev!.to, "total")
  );
  const products = useCached<ProductMeta[]>(cache, ready && view === "products" ? `${g}:products` : null, () => source.products());

  const refresh = () => {
    cache.clear();
    setNow(nowRef.current());
    setGeneration((n) => n + 1);
  };

  if (!ready) return <Loading />;

  return (
    <div className="space-y-6">
      <nav aria-label="Analytics views">
        <ul className="flex flex-wrap gap-2">
          {VIEWS.map((v) => (
            <li key={v.id}>
              <a
                href={hrefFor(v.id, preset, custom)}
                aria-current={view === v.id ? "page" : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate({ view: v.id });
                }}
                className={`inline-block rounded-full border px-3.5 py-1.5 text-xs uppercase tracking-wider transition-colors ${focusRing} ${
                  view === v.id ? "border-ink bg-ink text-cream" : "border-ink/15 text-ink-muted hover:border-ink/40 hover:text-ink"
                } ${v.id === "orders" ? "sm:ml-2" : ""}`}
              >
                {v.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {view === "orders" ? (
        <AnalyticsDashboard />
      ) : (
        <>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={preset === p.id}
                  onClick={() => navigate({ preset: p.id, custom: p.id === "custom" ? custom : {} })}
                  className={`rounded-full px-3.5 py-1.5 text-xs uppercase tracking-wider ${focusRing} ${
                    preset === p.id ? "bg-terracotta-dark text-white" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={refresh}
                className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs uppercase tracking-wider text-ink-muted hover:text-ink ${focusRing}`}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
              </button>
            </div>

            {preset === "custom" && (
              <form
                className="flex flex-wrap items-end gap-3 rounded-xl bg-linen/50 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate({ custom: { ...draft } });
                }}
              >
                <label className="text-xs text-ink-muted">
                  From
                  <input
                    type="date"
                    value={draft.from}
                    max={yesterday}
                    onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                    className={`mt-1 block rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink ${focusRing}`}
                  />
                </label>
                <label className="text-xs text-ink-muted">
                  To
                  <input
                    type="date"
                    value={draft.to}
                    max={yesterday}
                    onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                    className={`mt-1 block rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink ${focusRing}`}
                  />
                </label>
                <button
                  type="submit"
                  className={`rounded-full bg-ink px-4 py-2 text-xs uppercase tracking-wider text-cream hover:bg-ink-light ${focusRing}`}
                >
                  Show
                </button>
                <p className="w-full text-xs text-ink-muted">IST dates, up to yesterday. Compared with the same number of days before.</p>
              </form>
            )}

            <Freshness range={range} health={health} now={now} />
          </div>

          {health?.problem && <Warning>{health.problem}</Warning>}

          <section aria-labelledby="an-view-title" className="space-y-4">
            <h2 id="an-view-title" className="font-heading text-2xl text-ink">
              {VIEWS.find((v) => v.id === view)?.label}
              {range && <span className="mt-0.5 block font-body text-sm text-ink-muted">{rangeLabel(range)}</span>}
            </h2>

            {!resolved.ok ? (
              <p role="alert" className="text-sm text-terracotta-deep">
                {resolved.error}
              </p>
            ) : range!.live ? (
              <TodayBody
                view={view}
                diag={diag}
                paymentsLive={paymentsLive}
                range={range!}
              />
            ) : report.status === "loading" ? (
              <Loading />
            ) : report.status === "error" ? (
              <LoadError message={report.error} onRetry={report.retry} />
            ) : coverageOf(report.data) === "none" ? (
              <Empty>{describeGaps(report.data)}</Empty>
            ) : (
              <>
                {describeGaps(report.data) && <Note>{describeGaps(report.data)}</Note>}
                {view === "overview" && (
                  <OverviewView
                    range={range!}
                    current={report.data as Report<TotalRow>}
                    totals={totalsFromReport(report.data.rows as TotalRow[])}
                    previous={
                      // Not fully processed → "no comparison"; still loading or
                      // failed to load → no change line at all.
                      prevReport.status !== "ready"
                        ? "skip"
                        : coverageOf(prevReport.data) === "complete"
                          ? totalsFromReport(prevReport.data.rows)
                          : null
                    }
                    paymentsLive={paymentsLive}
                  />
                )}
                {view === "funnel" && (
                  <FunnelView totals={totalsFromReport(report.data.rows as TotalRow[])} paymentsLive={paymentsLive} live={false} />
                )}
                {view === "products" && (
                  <ProductsView
                    rows={report.data.rows as GrainRow[]}
                    meta={products.status === "ready" ? products.data : null}
                    metaError={products.status === "error" ? products.error : null}
                    paymentsLive={paymentsLive}
                  />
                )}
                {view === "sources" && <SourcesView rows={report.data.rows as GrainRow[]} />}
                {view === "geography" && <GeographyView rows={report.data.rows as GrainRow[]} />}
                {view === "devices" && <DevicesView rows={report.data.rows as GrainRow[]} />}
                {view === "search" && <SearchView rows={report.data.rows as GrainRow[]} />}
              </>
            )}
          </section>

          {view === "overview" && (
            <HealthPanel health={health} today={diag.status === "ready" ? classesFromDiagnostics(diag.data) : null} />
          )}
        </>
      )}
    </div>
  );
}

/** What the figures on screen are, and how fresh. Final and live are never blurred. */
function Freshness({ range, health, now }: { range: Range | null; health: ReturnType<typeof healthFrom> | null; now: Date }) {
  if (range?.live) {
    return (
      <p className="text-xs text-ink-muted">
        <span className="font-medium text-ink">Live count for today so far</span>, as of {formatIstTime(now.toISOString())} —
        provisional. Final figures for today are prepared tomorrow at 2:00 am IST.
      </p>
    );
  }
  if (!health) return <p className="text-xs text-ink-muted">Checking how fresh the figures are…</p>;
  return (
    <p className="text-xs text-ink-muted">
      <span className="font-medium text-ink">
        Final figures through {health.dataThrough ? `${formatDay(health.dataThrough)}, 11:59 pm IST` : "— none processed yet"}
      </span>
      {health.lastSuccessfulRun && <> · last updated {formatIstTime(health.lastSuccessfulRun)}</>}
      {" · customer activity only"}
    </p>
  );
}

function TodayBody({
  view,
  diag,
  paymentsLive,
  range,
}: {
  view: View;
  diag: Load<Diagnostics> & { retry: () => void };
  paymentsLive: boolean;
  range: Range;
}) {
  if (view !== "overview" && view !== "funnel") {
    return (
      <Empty>
        Breakdowns for today appear once the day is over and processed (2:00 am IST). Choose Yesterday or a longer range.
      </Empty>
    );
  }
  if (diag.status === "loading") return <Loading />;
  if (diag.status === "error") return <LoadError message={diag.error} onRetry={diag.retry} />;
  const totals = totalsFromDiagnostics(diag.data);
  return view === "overview" ? (
    <OverviewView range={range} totals={totals} previous="skip" current={null} paymentsLive={paymentsLive} />
  ) : (
    <FunnelView totals={totals} paymentsLive={paymentsLive} live />
  );
}

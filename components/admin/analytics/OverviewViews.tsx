"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import LineChart from "@/components/admin/charts/LineChart";
import {
  compare,
  dailySeries,
  describeChange,
  formatCount,
  formatDay,
  formatIstTime,
  formatPer100,
  formatShortDay,
  funnel,
  OVERVIEW_METRICS,
  previousLabel,
  type EventType,
  type Health,
  type Range,
  type Report,
  type Totals,
  type TotalRow,
  type TrafficClasses,
} from "@/lib/analyticsDashboard";
import { Empty, Note, Panel, focusRing } from "./ui";

// ── Shared notes ────────────────────────────────

export function PurchaseNote({ paymentsLive }: { paymentsLive: boolean }) {
  if (paymentsLive) {
    return <Note>Purchases are paid online orders, one per order. In-person sales are not web purchases and are not counted.</Note>;
  }
  return (
    <Note>
      Card payments are still in test mode, so every purchase so far is a test and is not counted here. Customer
      purchases appear from the live payment launch.
    </Note>
  );
}

// ── Overview ────────────────────────────────────

function ChangeLine({ text, direction }: { text: string; direction: "up" | "down" | "same" | null }) {
  const Icon = direction === "up" ? ArrowUp : direction === "down" ? ArrowDown : direction === "same" ? Minus : null;
  return (
    <p className="mt-1.5 flex items-start gap-1 text-xs leading-snug text-ink-muted">
      {Icon && <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
      <span>{text}</span>
    </p>
  );
}

const TREND_METRICS: EventType[] = ["page_view", "product_view", "search", "cart_add", "checkout_start"];

export function OverviewView({
  range,
  totals,
  previous,
  current,
  paymentsLive,
}: {
  range: Range;
  totals: Totals;
  /** Previous-period totals, or null when it is not fully covered / not compared. */
  previous: Totals | null | "skip";
  /** The finished-day report behind `totals` (absent for Today). */
  current: Report<TotalRow> | null;
  paymentsLive: boolean;
}) {
  const [trend, setTrend] = useState<EventType>("product_view");
  const prevLabel = previousLabel(range);
  const allZero = OVERVIEW_METRICS.every((m) => totals[m.type].events === 0);
  const series = current ? dailySeries(current, trend) : [];
  const trendLabel = OVERVIEW_METRICS.find((m) => m.type === trend)?.label ?? trend;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {OVERVIEW_METRICS.map((m) => {
          const value = totals[m.type].events;
          // Unprocessed previous period: said once below the cards, not eight times.
          const change = previous === "skip" || previous === null ? null : describeChange(compare(value, previous[m.type].events), prevLabel);
          return (
            <div key={m.type} className="rounded-xl border border-ink/10 bg-cream p-4">
              <p className="text-xs uppercase tracking-wider text-ink-muted">{m.label}</p>
              <p className="mt-1.5 font-heading text-3xl tabular-nums text-ink">{formatCount(value)}</p>
              {m.type === "cart_add" && totals.cart_add.units > 0 && (
                <p className="text-xs text-ink-muted">{formatCount(totals.cart_add.units)} units</p>
              )}
              {m.type === "purchase" && totals.purchase.units > 0 && (
                <p className="text-xs text-ink-muted">{formatCount(totals.purchase.units)} units sold</p>
              )}
              {change && <ChangeLine {...change} />}
              {range.live && <p className="mt-1.5 text-xs text-ink-muted">So far today · provisional</p>}
            </div>
          );
        })}
      </div>

      <div className="space-y-1.5">
        {previous === null && (
          <Note>No comparison: {prevLabel} {range.days === 1 ? "is" : "are"} not fully processed (for example, before collection began).</Note>
        )}
        <PurchaseNote paymentsLive={paymentsLive} />
        <Note>A WhatsApp click is a conversation started, not a sale.</Note>
        <Note>
          Revenue isn&apos;t shown in these figures
          {paymentsLive ? "" : " — it becomes meaningful at the live payment launch"}. Order totals are under Orders
          &amp; stock.
        </Note>
        <Note>Visitor and session metrics are not enabled: Wovenne counts events without identifying visitors.</Note>
      </div>

      {current && range.days >= 2 && (
        <Panel
          title="Day by day"
          id="an-trend"
          hint="Customer events per IST day. Days with no processed figures are left out, not drawn as zero."
        >
          <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            Show
            <select
              value={trend}
              onChange={(e) => setTrend(e.target.value as EventType)}
              className={`rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink ${focusRing}`}
            >
              {TREND_METRICS.map((t) => (
                <option key={t} value={t}>
                  {OVERVIEW_METRICS.find((m) => m.type === t)?.label}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3">
            {series.length === 0 ? (
              <Empty>No processed days in this range yet.</Empty>
            ) : allZero ? (
              <Empty>No customer activity in this period.</Empty>
            ) : (
              <>
                {[
                  { cls: "sm:hidden", width: 320 },
                  { cls: "hidden sm:block", width: 600 },
                ].map((v) => (
                  <div key={v.width} className={v.cls}>
                    <LineChart
                      width={v.width}
                      points={series.map((p) => ({ label: formatShortDay(p.day), value: p.value }))}
                      format={(n) => formatCount(Math.round(n))}
                      emptyMessage="No processed days in this range yet."
                    />
                  </div>
                ))}
                <details className="mt-2 text-sm">
                  <summary className={`cursor-pointer text-xs uppercase tracking-wider text-ink-muted hover:text-ink ${focusRing}`}>
                    Show as a table
                  </summary>
                  <table className="mt-2 w-full max-w-sm text-sm">
                    <caption className="sr-only">{trendLabel} per day</caption>
                    <thead>
                      <tr className="border-b border-ink/10 text-xs text-ink-muted">
                        <th scope="col" className="py-1.5 text-left font-normal">Day (IST)</th>
                        <th scope="col" className="py-1.5 text-right font-normal">{trendLabel}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {series.map((p) => (
                        <tr key={p.day} className="border-b border-ink/5 last:border-0">
                          <th scope="row" className="py-1.5 text-left font-normal text-ink">{formatDay(p.day)}</th>
                          <td className="py-1.5 text-right tabular-nums text-ink">{formatCount(p.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ── Funnel ──────────────────────────────────────

export function FunnelView({ totals, paymentsLive, live }: { totals: Totals; paymentsLive: boolean; live: boolean }) {
  const steps = funnel(totals);
  const max = Math.max(...steps.map((s) => s.events), 1);
  if (steps.every((s) => s.events === 0)) {
    return (
      <div className="space-y-3">
        <Empty>No customer product views, cart adds or checkouts in this period.</Empty>
        <PurchaseNote paymentsLive={paymentsLive} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Panel
        title="From product view to purchase"
        id="an-funnel"
        hint="Counts of events, not people: one shopper viewing a product five times is five product views. A step can be larger than the one before it, and is shown as it is."
      >
        <ol className="space-y-4">
          {steps.map((s, i) => (
            <li key={s.type}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink">
                  <span className="text-ink-muted">{i + 1}.</span> {s.label}
                </span>
                <span className="font-heading text-2xl tabular-nums text-ink">
                  {formatCount(s.events)}
                  {live && <span className="sr-only"> so far today</span>}
                </span>
              </div>
              <div aria-hidden className="mt-1 h-3 overflow-hidden rounded-full bg-ink/5">
                <div
                  className="h-full rounded-full bg-terracotta"
                  style={{ width: `${s.events === 0 ? 0 : Math.max((s.events / max) * 100, 2)}%` }}
                />
              </div>
              {s.ratioLabel && (
                <p className="mt-1 text-xs text-ink-muted">
                  <span className="tabular-nums text-ink">{formatPer100(s.ratio)}</span> {s.ratioLabel}
                  {s.ratio === null && ` — no ${steps[i - 1].label.toLowerCase()} to compare with`}
                  {s.exceedsPrevious && " — more than the step before, which events can do"}
                </p>
              )}
            </li>
          ))}
        </ol>
      </Panel>
      <PurchaseNote paymentsLive={paymentsLive} />
      {live && <Note>Today&apos;s funnel is a provisional count of a day still in progress.</Note>}
    </div>
  );
}

// ── Health ──────────────────────────────────────

function ClassLine({ c }: { c: TrafficClasses }) {
  return (
    <>
      {formatCount(c.customer)} customer · {formatCount(c.internal)} staff · {formatCount(c.test)} test
    </>
  );
}

/**
 * Is Analytics working? Compact, admin-only, and separate from the business
 * figures — internal and test counts appear here and nowhere else.
 */
export function HealthPanel({ health, today }: { health: Health | null; today: TrafficClasses | null }) {
  if (!health) return null;
  const rows: [string, React.ReactNode][] = [
    [
      "Collection",
      health.collecting === null ? "Unknown" : health.collecting ? "On" : <span className="text-terracotta-deep">Off</span>,
    ],
    ["Final figures through", health.dataThrough ? `${formatDay(health.dataThrough)}, end of day (IST)` : "No processed days yet"],
    [
      "Last nightly update",
      health.lastRun ? (
        <>
          {formatIstTime(health.lastRun.ran_at)} — {health.lastRun.ok ? "succeeded" : <span className="text-terracotta-deep">failed</span>}
          {!health.lastRun.ok && health.lastSuccessfulRun && (
            <span className="block text-xs text-ink-muted">Last success: {formatIstTime(health.lastSuccessfulRun)}</span>
          )}
        </>
      ) : (
        "Not run yet"
      ),
    ],
    [
      "Reconciliation",
      health.reconciledDay ? (
        <>
          {formatDay(health.reconciledDay)}:{" "}
          {health.reconciled ? "figures match the raw events" : <span className="text-terracotta-deep">figures do not match the raw events</span>}
        </>
      ) : (
        "Nothing to reconcile yet"
      ),
    ],
    ["Raw events", "Kept 180 days, and removed only for days whose figures reconcile"],
  ];
  if (health.classes && health.reconciledDay) {
    rows.push([`Events on ${formatDay(health.reconciledDay)}`, <ClassLine key="c" c={health.classes} />]);
  }
  if (today) rows.push(["Events today so far", <ClassLine key="t" c={today} />]);

  return (
    <Panel
      title="Data status"
      id="an-health"
      hint="Only customer events are counted in the figures above; staff and test events are shown here and excluded everywhere else."
    >
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

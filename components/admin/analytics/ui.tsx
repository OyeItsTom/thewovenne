"use client";

import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Info, Loader2 } from "lucide-react";
import {
  ACTIVITY,
  formatCount,
  sortRows,
  type DimensionLine,
  type SortDir,
} from "@/lib/analyticsDashboard";

/**
 * The pieces every Analytics view is built from. Styling follows the existing
 * admin (cream panels, ink text, terracotta accents); secondary text uses
 * ink-muted rather than ink/50, which falls below 4.5:1 at these sizes.
 */

export function Panel({
  title,
  hint,
  children,
  id,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-ink/10 bg-cream p-4 sm:p-6">
      <h3 id={id} className="font-heading text-xl text-ink">
        {title}
      </h3>
      {hint && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A quiet explanatory line — present, never dominant. */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-deep">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-linen/50 px-4 py-6 text-center text-sm text-ink-muted">{children}</p>;
}

export function Loading({ label = "Reading the figures…" }: { label?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-6 text-sm text-ink-muted">
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> {label}
    </p>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-terracotta/30 bg-terracotta/5 px-4 py-4 text-sm text-terracotta-deep">
      <p>Couldn&apos;t load these figures: {message}</p>
      <p className="mt-1 text-xs text-ink-muted">Nothing is shown rather than a zero that might not be true.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full border border-ink/20 px-4 py-1.5 text-xs uppercase tracking-wider text-ink hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
      >
        Try again
      </button>
    </div>
  );
}

export const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta";

/**
 * Horizontal bars for a quick read. DECORATIVE: the same figures are in the
 * table beside it, so the bars are hidden from screen readers rather than
 * read out twice.
 */
export function Bars({
  bars,
  max: maxIn,
}: {
  bars: { label: string; value: number }[];
  max?: number;
}) {
  const shown = bars.filter((b) => b.value > 0);
  if (shown.length === 0) return null;
  const max = Math.max(maxIn ?? 0, ...shown.map((b) => b.value), 1);
  return (
    <ul aria-hidden className="space-y-2.5">
      {shown.map((b) => (
        <li key={b.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink">{b.label}</span>
            <span className="shrink-0 tabular-nums text-ink-muted">{formatCount(b.value)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink/5">
            <div className="h-full rounded-full bg-terracotta" style={{ width: `${Math.max((b.value / max) * 100, 2)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Sortable table ──────────────────────────────

export interface Column<T> {
  id: string;
  label: string;
  /** The value the column sorts by; omit for an unsortable column. */
  sort?: (r: T) => number | string | null;
  cell: (r: T) => React.ReactNode;
  numeric?: boolean;
}

/**
 * A real <table> from md up (caption, column headers, row headers, aria-sort);
 * below md the same rows as stacked cards with a "Sort by" select — no
 * sideways scrolling on a phone. Long lists show the first `limit` rows with a
 * button for the rest.
 */
export function DataTable<T>({
  caption,
  rows,
  columns,
  rowKey,
  rowLabel,
  initialSort,
  initialDir = "desc",
  limit = 15,
}: {
  caption: string;
  rows: readonly T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  rowLabel: (r: T) => string;
  initialSort: string;
  initialDir?: SortDir;
  limit?: number;
}) {
  const [sortId, setSortId] = useState(initialSort);
  const [dir, setDir] = useState<SortDir>(initialDir);
  const [all, setAll] = useState(false);

  const col = columns.find((c) => c.id === sortId && c.sort) ?? columns.find((c) => c.sort);
  const sorted = col?.sort ? sortRows(rows, col.sort, dir, rowLabel) : [...rows];
  const visible = all ? sorted : sorted.slice(0, limit);
  const [first, ...rest] = columns;

  const choose = (id: string) => {
    if (id === sortId) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortId(id);
      // Text columns read naturally A→Z; numbers biggest first.
      setDir(columns.find((c) => c.id === id)?.numeric ? "desc" : "asc");
    }
  };

  return (
    <div>
      {/* Phones: cards */}
      <div className="md:hidden">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="shrink-0">Sort by</span>
          <select
            value={`${col?.id ?? ""}:${dir}`}
            onChange={(e) => {
              const [id, d] = e.target.value.split(":");
              setSortId(id);
              setDir(d as SortDir);
            }}
            className={`min-w-0 flex-1 rounded-lg border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink ${focusRing}`}
          >
            {columns
              .filter((c) => c.sort)
              .flatMap((c) => [
                <option key={`${c.id}:desc`} value={`${c.id}:desc`}>
                  {c.label} {c.numeric ? "(high → low)" : "(Z → A)"}
                </option>,
                <option key={`${c.id}:asc`} value={`${c.id}:asc`}>
                  {c.label} {c.numeric ? "(low → high)" : "(A → Z)"}
                </option>,
              ])}
          </select>
        </label>
        <ul className="mt-3 space-y-2" aria-label={caption}>
          {visible.map((r) => (
            <li key={rowKey(r)} className="rounded-xl border border-ink/10 px-3 py-2.5">
              <div className="text-sm text-ink">{first.cell(r)}</div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {rest.map((c) => (
                  <div key={c.id} className="flex items-baseline justify-between gap-2">
                    <dt className="text-ink-muted">{c.label}</dt>
                    <dd className="tabular-nums text-ink">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </div>

      {/* Tablet and up: a table */}
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {caption}
            {col ? `, sorted by ${col.label}, ${dir === "desc" ? "descending" : "ascending"}` : ""}
          </caption>
          <thead>
            <tr className="border-b border-ink/10 text-xs text-ink-muted">
              {columns.map((c) => (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={col?.id === c.id ? (dir === "desc" ? "descending" : "ascending") : undefined}
                  className={`py-2 font-normal ${c.numeric ? "text-right" : "text-left"} ${c === first ? "" : "pl-3"}`}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      onClick={() => choose(c.id)}
                      className={`inline-flex items-center gap-1 rounded hover:text-ink ${focusRing} ${col?.id === c.id ? "text-ink" : ""}`}
                    >
                      {c.label}
                      {col?.id === c.id ? (
                        dir === "desc" ? (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden />
                      )}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={rowKey(r)} className="border-b border-ink/5 last:border-0">
                <th scope="row" className="py-2.5 pr-3 text-left font-normal text-ink">
                  {first.cell(r)}
                </th>
                {rest.map((c) => (
                  <td key={c.id} className={`py-2.5 pl-3 tabular-nums text-ink ${c.numeric ? "text-right" : "text-left"}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length > limit && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className={`mt-3 text-xs uppercase tracking-wider text-ink-muted hover:text-ink ${focusRing}`}
        >
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

/** A breakdown (source, country, device…) with the four browser activities. */
export function DimensionTable({
  caption,
  lines,
  firstLabel,
  limit,
}: {
  caption: string;
  lines: DimensionLine[];
  firstLabel: string;
  limit?: number;
}) {
  return (
    <DataTable
      caption={caption}
      rows={lines}
      rowKey={(l) => l.key}
      rowLabel={(l) => l.label}
      initialSort="page_view"
      limit={limit}
      columns={[
        {
          id: "label",
          label: firstLabel,
          sort: (l) => l.label,
          cell: (l) => (
            <span>
              <span className={l.unknown ? "italic" : undefined}>{l.label}</span>
              {l.detail && <span className="block text-xs text-ink-muted">{l.detail}</span>}
            </span>
          ),
        },
        ...ACTIVITY.map((a) => ({
          id: a.type,
          label: a.label,
          numeric: true,
          sort: (l: DimensionLine) => l.counts[a.type],
          cell: (l: DimensionLine) => formatCount(l.counts[a.type]),
        })),
      ]}
    />
  );
}

"use client";

/**
 * A horizontal bar chart.
 *
 * Horizontal rather than vertical because the labels are product names: read
 * left to right at full length, instead of rotated forty-five degrees or
 * truncated to three characters.
 *
 * Plain divs rather than SVG — a bar is a rectangle with a width, and CSS does
 * that natively with text that wraps and reflows on a phone.
 */

export interface Bar {
  label: string;
  value: number;
  /** Optional second line, e.g. units alongside revenue. */
  detail?: string;
}

export default function BarChart({
  bars,
  format = (n) => String(n),
  emptyMessage = "No data yet.",
}: {
  bars: Bar[];
  format?: (n: number) => string;
  emptyMessage?: string;
}) {
  if (bars.length === 0) {
    return <p className="py-8 text-center text-sm text-ink/50">{emptyMessage}</p>;
  }

  // Scaled to the largest bar, not to a total: this compares items with each
  // other, which is the question being asked.
  const max = Math.max(...bars.map((b) => b.value), 1);

  return (
    <ul className="space-y-3">
      {bars.map((bar, i) => (
        <li key={`${bar.label}-${i}`}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink">{bar.label}</span>
            <span className="shrink-0 text-ink/70">{format(bar.value)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink/5">
            <div
              className="h-full rounded-full bg-terracotta"
              style={{ width: `${Math.max((bar.value / max) * 100, 2)}%` }}
            />
          </div>
          {bar.detail && (
            <p className="mt-1 text-xs text-ink/50">{bar.detail}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

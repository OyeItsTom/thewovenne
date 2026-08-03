"use client";

/**
 * A line chart, drawn by hand.
 *
 * No charting library: the data is tens of points, and every library ships its
 * own visual language that would have to be overridden back to this one. An SVG
 * path is a few lines of arithmetic and looks like the rest of the site.
 *
 * viewBox with preserveAspectRatio="none" would stretch strokes unevenly, so it
 * scales properly instead — the chart is drawn in its own coordinate space and
 * the SVG is sized by CSS.
 */

export interface LinePoint {
  label: string;
  value: number;
}

const W = 600;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 48 };

export default function LineChart({
  points,
  format = (n) => String(n),
  colour = "#C2714F",
  emptyMessage = "No data yet.",
}: {
  points: LinePoint[];
  format?: (n: number) => string;
  colour?: string;
  emptyMessage?: string;
}) {
  if (points.length === 0) {
    return <p className="py-12 text-center text-sm text-ink/50">{emptyMessage}</p>;
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  // Always from zero: a chart that starts at the minimum exaggerates small
  // movements into cliffs, which is how a flat week reads as a collapse.
  const min = 0;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (i: number) =>
    PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");
  const area = `${path} L${x(points.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`;

  // Three gridlines is enough to read a value without becoming a table.
  const ticks = [0, max / 2, max];

  // Only a few labels, or they collide on a narrow screen.
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  const allZero = values.every((v) => v === 0);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-56 w-full"
        role="img"
        aria-label={`Chart: ${points.length} points, highest ${format(max)}`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="#1C1F3B"
              strokeOpacity={0.08}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="#1C1F3B"
              fillOpacity={0.45}
            >
              {format(t)}
            </text>
          </g>
        ))}

        {!allZero && (
          <>
            <path d={area} fill={colour} fillOpacity={0.08} />
            <path
              d={path}
              fill="none"
              stroke={colour}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {points.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p.value)} r={2.5} fill={colour}>
                <title>{`${p.label}: ${format(p.value)}`}</title>
              </circle>
            ))}
          </>
        )}

        {points.map((p, i) =>
          i % labelEvery === 0 || i === points.length - 1 ? (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize={10}
              fill="#1C1F3B"
              fillOpacity={0.45}
            >
              {p.label}
            </text>
          ) : null
        )}
      </svg>

      {allZero && (
        <p className="-mt-16 text-center text-sm text-ink/50">
          Nothing in this period yet.
        </p>
      )}
    </div>
  );
}

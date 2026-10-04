"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { formatINR } from "@/lib/utils";
import {
  ceilingFor,
  ceilingLabel,
  sliderPosition,
  type PriceSliderRange,
} from "@/lib/priceSlider";

/**
 * A maximum-price slider, built on a native <input type="range">.
 *
 * NATIVE ON PURPOSE. The browser already gives a range input everything this
 * needs: arrow keys, Page Up/Down, Home/End, touch dragging, and a role a
 * screen reader announces as a slider with its value. Only the look is ours
 * (.price-range in globals.css) — a hairline track and a small thumb inside a
 * 44px-tall hit area.
 *
 * COMMITTED WHEN THE HAND STOPS, NOT ON EVERY PIXEL. On the shop each change
 * is a server round trip, and a drag fires dozens. So the label follows the
 * thumb immediately, and the filter is applied on release (pointer up), after
 * a short pause in keyboard input, or when focus leaves — whichever comes
 * first. Tapping "Show N products" in the drawer blurs the slider first, so a
 * last-moment change is never lost.
 */
export default function PriceSlider({
  range,
  maxPrice,
  onCommit,
}: {
  range: PriceSliderRange;
  /** The ceiling in force (from the URL). Null: no ceiling. */
  maxPrice: number | null;
  onCommit: (maxPrice: number | null) => void;
}) {
  const inputId = useId();
  const [position, setPosition] = useState(() => sliderPosition(range, maxPrice));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The newest callback and value, so a delayed commit never acts on the props
  // of the render that scheduled it.
  const latest = useRef({ onCommit, maxPrice, range });
  latest.current = { onCommit, maxPrice, range };

  // Follow the URL when it changes from elsewhere: a chip removed, Clear all.
  // Keyed on the numbers, not the range object, which the parent rebuilds on
  // every render — including the one that marks the shop's navigation as
  // pending, which would otherwise snap the thumb back mid-commit.
  const { min, max, step } = range;
  useEffect(() => {
    setPosition(sliderPosition({ ...latest.current.range, min, max, step }, maxPrice));
  }, [min, max, step, maxPrice]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const commit = (pos: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { onCommit: apply, maxPrice: current, range: r } = latest.current;
    const next = ceilingFor(r, pos);
    if (next !== current) apply(next);
  };

  // A ceiling from a hand-edited link (?maxPrice=1234) is shown as itself
  // while the thumb has not moved off it; otherwise the label is the stop.
  const untouched = position === sliderPosition(range, maxPrice);
  const shown = untouched ? maxPrice : ceilingFor(range, position);
  const label = ceilingLabel(shown !== null && shown >= range.max ? null : shown);
  const fill = ((position - range.min) / (range.max - range.min)) * 100;

  return (
    <div className="pb-1">
      <label htmlFor={inputId} className="sr-only">
        Maximum price
      </label>
      {/* The value, said once: visually here, and to a screen reader through
          aria-valuetext on the slider itself — not a live region, which would
          announce every stop of a drag twice. */}
      <p aria-hidden className="text-sm text-ink">
        {label}
      </p>
      <input
        id={inputId}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={position}
        aria-valuetext={label}
        onChange={(e) => {
          const pos = Number(e.target.value);
          setPosition(pos);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(pos), 400);
        }}
        // Only when the value MOVED (a change is pending). A plain click on
        // the thumb fires pointerup with no change — and with an off-stop
        // ceiling from an old link (?maxPrice=1777, drawn at the ₹1,800 stop)
        // committing then would silently rewrite the customer's filter.
        onPointerUp={(e) => {
          if (timer.current) commit(Number((e.target as HTMLInputElement).value));
        }}
        onBlur={(e) => {
          if (timer.current) commit(Number(e.target.value));
        }}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        className="price-range mt-1 block w-full"
      />
      <div aria-hidden className="flex justify-between text-xs text-ink-muted">
        <span>{formatINR(range.lowest)}</span>
        <span>{formatINR(range.highest)}</span>
      </div>
    </div>
  );
}

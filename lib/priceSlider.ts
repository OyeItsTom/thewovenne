import { formatINR } from "./utils";

/**
 * The Price filter's slider: one maximum, chosen on a continuous-feeling track.
 *
 * ONE PARAMETER, THE ONE THAT WAS ALREADY THERE. The URL still carries a single
 * inclusive ceiling, ?maxPrice=2000, compared against the price SHOWN on the
 * card (lib/pricing withinPriceCeiling — a live discount included). The slider
 * is only a new way of choosing that number; every link written for the old
 * "Under ₹2,500" buttons still means exactly what it meant.
 *
 * DERIVED, NEVER HARD-CODED. The ends come from the prices in the listing, so a
 * new ₹12,000 saree widens the track without anybody editing a list.
 *
 * PURE: tested in scripts/price-slider.test.ts.
 */

export interface PriceSliderRange {
  /** The lowest ceiling worth offering: the cheapest piece, rounded UP to a step. */
  min: number;
  /** The track's far end: the dearest piece, rounded up. Here the filter is off. */
  max: number;
  step: number;
  /** The cheapest and dearest shown prices, for the labels under the track. */
  lowest: number;
  highest: number;
}

/**
 * A step that keeps the track usable at any catalogue scale: ₹100 across
 * today's ₹390–₹3,299 (about thirty stops), coarser once the spread is wide
 * enough that ₹100 stops would make the arrow keys a chore.
 */
export function priceStep(spread: number): number {
  if (spread <= 10_000) return 100;
  if (spread <= 50_000) return 500;
  return 1_000;
}

/**
 * The slider's range for these SHOWN prices, or null when no ceiling could
 * narrow them — one price, or every price inside a single step.
 *
 * The low end is rounded UP so its first stop still includes the cheapest
 * piece: a ₹390 ring with the track starting at ₹300 would put a stop on the
 * track that empties the grid.
 */
export function priceSliderRange(prices: readonly number[]): PriceSliderRange | null {
  const finite = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (finite.length === 0) return null;
  const lowest = Math.min(...finite);
  const highest = Math.max(...finite);
  const step = priceStep(highest - lowest);
  const min = Math.ceil(lowest / step) * step;
  const max = Math.ceil(highest / step) * step;
  // A stop below `max` must leave something out, or the track has nothing to do.
  if (min >= max) return null;
  return { min, max, step, lowest, highest };
}

/**
 * Where the thumb sits for a ceiling. No ceiling, or one at or past the far
 * end, is the far end. A ceiling below the first stop (a hand-edited link) sits
 * at the first stop; the URL value itself is still what filters.
 */
export function sliderPosition(range: PriceSliderRange, maxPrice: number | null): number {
  if (maxPrice === null || maxPrice >= range.max) return range.max;
  return Math.max(range.min, maxPrice);
}

/**
 * The ceiling a thumb position means. The far end means no ceiling at all — so
 * dragging back to the end clears the filter and the URL, rather than leaving
 * a ?maxPrice that happens to change nothing.
 */
export function ceilingFor(range: PriceSliderRange, position: number): number | null {
  const snapped = Math.round(position / range.step) * range.step;
  const clamped = Math.min(range.max, Math.max(range.min, snapped));
  return clamped >= range.max ? null : clamped;
}

/** "Up to ₹2,000", or "Any price" with no ceiling. Whole rupees, never decimals. */
export function ceilingLabel(maxPrice: number | null): string {
  return maxPrice === null ? "Any price" : `Up to ${formatINR(Math.round(maxPrice))}`;
}

import type { ProductSize } from "./sizes";

/**
 * What a page may say about availability, decided in one place.
 *
 * WHY IT IS A FUNCTION AND NOT AN INLINE TERNARY. "Is this nearly gone?" has
 * three different answers depending on whether a product has sizes, and the
 * product page, the card and the size selector were each deciding for
 * themselves — which is how a card came to say "Only 5 left" while the page it
 * links to said nothing at all. One function, one threshold, and a test that
 * pins the wording.
 *
 * FEWER THAN THREE, per the brief. Three is a shelf; two is a decision. A
 * threshold of five — what the card used — is high enough to be showing an
 * urgency notice on most of a small catalogue most of the time, which is exactly
 * how the device stops being believed.
 */
export const LOW_STOCK_THRESHOLD = 3;

export interface StockState {
  /** Nothing can be bought — no sizes have stock, or a single-stock piece is at zero. */
  soldOut: boolean;
  /** Something is buyable, and not much of it. */
  low: boolean;
  /** Units left, when a single number is meaningful. Null for a sized product. */
  remaining: number | null;
  /** Sizes that are low but still buyable, in display order. */
  lowSizes: string[];
  /** Sizes with nothing left. */
  soldOutSizes: string[];
}

export function stockState(
  productStock: number,
  sizes: ProductSize[] = []
): StockState {
  // A sized product's own stock_quantity is not the truth — stock lives per size
  // (migration 0021), and a product with 10 in the column and nothing in any
  // size is sold out. Sizes win whenever they exist.
  if (sizes.length > 0) {
    const buyable = sizes.filter((s) => s.stock_quantity > 0);
    const lowSizes = buyable
      .filter((s) => s.stock_quantity < LOW_STOCK_THRESHOLD)
      .map((s) => s.label);

    return {
      soldOut: buyable.length === 0,
      low: buyable.length > 0 && lowSizes.length > 0,
      // Deliberately null: "only 2 left" across four sizes means nothing, and
      // adding them up would claim a total nobody can actually buy in one size.
      remaining: buyable.length === 1 ? buyable[0].stock_quantity : null,
      lowSizes,
      soldOutSizes: sizes.filter((s) => s.stock_quantity <= 0).map((s) => s.label),
    };
  }

  return {
    soldOut: productStock <= 0,
    low: productStock > 0 && productStock < LOW_STOCK_THRESHOLD,
    remaining: Math.max(productStock, 0),
    lowSizes: [],
    soldOutSizes: [],
  };
}

/** One and two as words. Numerals in a quiet line read as a countdown. */
const WORDS = ["", "one", "two"] as const;

/**
 * The line shown near the price, BEFORE anybody picks a size.
 *
 * This is the gap the brief names: low stock was visible only after selecting a
 * size, which is after the moment it would have mattered. Returns null when
 * there is nothing worth saying — most products, most of the time, which is what
 * keeps it meaning something when it does appear.
 *
 * It never counts down in numerals above two and never says "hurry". An elegant
 * nudge is a statement of fact in a quiet voice; the cheap version is the same
 * fact in red.
 */
export function stockNote(state: StockState): string | null {
  if (state.soldOut) return "Sold out";
  if (!state.low) return null;

  if (state.remaining !== null && state.remaining <= 2) {
    return `Almost gone — only ${WORDS[state.remaining]} left`;
  }

  // Sized, with more than one size still buyable: naming which sizes here would
  // duplicate the selector directly below, so this only says that it is close.
  if (state.lowSizes.length > 0) return "Almost gone in some sizes";

  return "Almost gone";
}

/**
 * The line shown once a customer has CHOSEN a size.
 *
 * Section 14 of the brief: inventory messaging follows the selection. Picking M
 * with two left says so; picking a healthy S says nothing; picking a sold-out L
 * is not this function's job at all — sold out is a separate state, said by the
 * size selector and the button, and "Only 0 left" must never be rendered.
 *
 * Takes the same threshold as everything else. There is one definition of low in
 * this file and no component is allowed a second opinion.
 */
export function sizeStockNote(stock: number, label: string): string | null {
  if (stock <= 0) return null;        // sold out is said elsewhere, once
  if (stock >= LOW_STOCK_THRESHOLD) return null;
  const word = WORDS[stock] ?? String(stock);
  return `Only ${word} left in ${label}`;
}

/**
 * The Price filter's slider (Natural Fabric PR #175): its range, its stops,
 * the one URL parameter it writes, and the price it compares against — the
 * one shown on the card.
 *
 *   npx tsx scripts/price-slider.test.ts
 *
 * Exits non-zero on failure. Pure functions and a static render; no browser.
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ceilingFor,
  ceilingLabel,
  priceSliderRange,
  priceStep,
  sliderPosition,
  type PriceSliderRange,
} from "../lib/priceSlider";
import { NO_FILTERS, catalogueSearchString, parseCatalogueParams } from "../lib/catalogueParams";
import { orderForDiscovery, activeFilters } from "../lib/catalogueDiscovery";
import { matchesFilters } from "../lib/productFilters";
import { shownPrice } from "../lib/pricing";
import type { Product } from "../lib/types";
import PriceSlider from "../components/shop/PriceSlider";

(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}`);
  if (good) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, condition: boolean) => check(name, condition, true);
const read = (p: string) => fs.readFileSync(p, "utf8");

// The live catalogue's SHOWN prices (PR #174 inventory; the ring and necklace on sale).
const LIVE = [390, 559, 1250, 1299, 1299, 1399, 1399, 1499, 1499, 1599, 1599, 3299];

console.log("\n=== the range comes from the prices, never a hard-coded list ===");
const shop = priceSliderRange(LIVE)!;
check("today's shop: ₹100 stops from ₹400 to ₹3,300", shop, { min: 400, max: 3300, step: 100, lowest: 390, highest: 3299 });
ok("the first stop still includes the cheapest piece (₹390 ≤ ₹400)", 390 <= shop.min);
ok("the last stop includes the dearest (₹3,299 ≤ ₹3,300)", 3299 <= shop.max);
check("a ₹12,000 piece widens the track and coarsens the step", priceSliderRange([...LIVE, 12000]), { min: 500, max: 12000, step: 500, lowest: 390, highest: 12000 });
check("step: ₹100 up to a ₹10,000 spread", [priceStep(2909), priceStep(10_000)], [100, 100]);
check("step: ₹500 up to ₹50,000, then ₹1,000", [priceStep(10_001), priceStep(50_000), priceStep(80_000)], [500, 500, 1000]);
check("no prices: no slider", priceSliderRange([]), null);
check("one price: no slider", priceSliderRange([1499]), null);
check("all within one stop: no slider", priceSliderRange([1401, 1450, 1500]), null);
check("junk prices are ignored", priceSliderRange([NaN, -5, 0, 390, 559]), { min: 400, max: 600, step: 100, lowest: 390, highest: 559 });

console.log("\n=== stops, ends and labels ===");
check("minimum stop", ceilingFor(shop, shop.min), 400);
check("the far end means NO ceiling (the filter clears itself)", ceilingFor(shop, shop.max), null);
check("one stop short of the end is a real ceiling", ceilingFor(shop, shop.max - shop.step), 3200);
check("positions snap to ₹100", [ceilingFor(shop, 1949), ceilingFor(shop, 1950), ceilingFor(shop, 2000)], [1900, 2000, 2000]);
check("below the track clamps to the first stop", ceilingFor(shop, 50), 400);
check("thumb with no ceiling sits at the far end", sliderPosition(shop, null), 3300);
check("thumb for ₹2,000 sits at ₹2,000", sliderPosition(shop, 2000), 2000);
check("a ceiling past the end sits at the end (and still filters as written)", sliderPosition(shop, 9000), 3300);
check("a ceiling below the first stop sits at the first stop", sliderPosition(shop, 100), 400);
check("labels: whole rupees, Indian grouping", [ceilingLabel(2000), ceilingLabel(400), ceilingLabel(1999.6)], ["Up to ₹2,000", "Up to ₹400", "Up to ₹2,000"]);
check("label with no ceiling", ceilingLabel(null), "Any price");
check("the chip says the same words as the slider", activeFilters({ ...NO_FILTERS, maxPrice: 2000 }).map((c) => c.label), ["Up to ₹2,000"]);

console.log("\n=== the price compared is the price SHOWN ===");
const DAY = 86_400_000;
const past = new Date(Date.now() - 10 * DAY).toISOString();
const soon = new Date(Date.now() + 10 * DAY).toISOString();
const yesterday = new Date(Date.now() - DAY).toISOString();
const item = (id: string, price: number, stock: number, extra: Partial<Product> = {}) =>
  ({ id, price_inr: price, stock_quantity: stock, fabric: null, colour: null, discount_type: null, discount_value: null,
     discount_starts_at: null, discount_ends_at: null, ...extra } as unknown as Product);
const EXACT = item("exact-2000", 2000, 2);
const SALE = item("sale-2299", 2299, 2, { discount_type: "percent", discount_value: 15, discount_starts_at: past, discount_ends_at: soon });
const EXPIRED = item("expired-2299", 2299, 2, { discount_type: "percent", discount_value: 15, discount_starts_at: past, discount_ends_at: yesterday });
const OVER = item("plain-2100", 2100, 2);
const CHEAP_SOLD = item("sold-900", 900, 0);
const CHEAP = item("plain-1200", 1200, 3);
const ALL = [EXACT, SALE, EXPIRED, OVER, CHEAP_SOLD, CHEAP];
const upTo = (max: number | null) =>
  ALL.filter((p) => matchesFilters(p, { ...NO_FILTERS, maxPrice: max }, {})).map((p) => p.id).sort();
check("exact boundary: a card showing ₹2,000 is within 'Up to ₹2,000'", upTo(2000).includes("exact-2000"), true);
check("…and not within 'Up to ₹1,900'", upTo(1900).includes("exact-2000"), false);
check("an active discount crosses the threshold: ₹2,299 shown at ₹1,954 is within ₹2,000", [shownPrice(SALE), upTo(2000).includes("sale-2299")], [1954, true]);
check("…but not within ₹1,900", upTo(1900).includes("sale-2299"), false);
check("an expired discount does not count: ₹2,299 stays out of ₹2,000", [shownPrice(EXPIRED), upTo(2000).includes("expired-2299")], [2299, false]);
check("no ceiling: everything", upTo(null).length, ALL.length);
{
  const range = priceSliderRange(ALL.map((p) => shownPrice(p)))!;
  check("the range uses shown prices: the sale's ₹1,954, not its stored ₹2,299", [range.lowest, range.highest], [900, 2299]);
}

console.log("\n=== the slider and the sort agree ===");
{
  const within = ALL.filter((p) => matchesFilters(p, { ...NO_FILTERS, maxPrice: 2000 }, {}));
  check("low → high: in stock first, by shown price, then sold out",
    orderForDiscovery(within, "price-asc").map((p) => p.id), ["plain-1200", "sale-2299", "exact-2000", "sold-900"]);
  check("high → low: in stock first, by shown price, then sold out",
    orderForDiscovery(within, "price-desc").map((p) => p.id), ["exact-2000", "sale-2299", "plain-1200", "sold-900"]);
  check("newest: arrival order inside each group", orderForDiscovery(within, null).map((p) => p.id), ["exact-2000", "sale-2299", "plain-1200", "sold-900"]);
}

console.log("\n=== one URL parameter, restored on reload ===");
check("a stop writes ?maxPrice=2000 and nothing else", catalogueSearchString({ ...NO_FILTERS, maxPrice: 2000 }), "maxPrice=2000");
check("the far end writes nothing", catalogueSearchString({ ...NO_FILTERS, maxPrice: ceilingFor(shop, shop.max) }), "");
check("reload: ?maxPrice=2000 puts the thumb back at ₹2,000", sliderPosition(shop, parseCatalogueParams({ maxPrice: "2000" }).maxPrice), 2000);
check("an old 'Under ₹2,500' link still means up to ₹2,500", parseCatalogueParams({ maxPrice: "2500" }).maxPrice, 2500);
check("a fractional hand-edited price is whole rupees", parseCatalogueParams({ maxPrice: "2000.4" }).maxPrice, 2000);

console.log("\n=== the control ===");
const html = (range: PriceSliderRange, maxPrice: number | null) =>
  renderToStaticMarkup(createElement(PriceSlider, { range, maxPrice, onCommit: () => {} }));
const at2000 = html(shop, 2000);
ok("a native range input with the derived min, max and ₹100 step",
  /<input id="[^"]+" type="range" min="400" max="3300" step="100" aria-valuetext="Up to ₹2,000"[^>]*value="2000"/.test(at2000));
ok("labelled for assistive tech ('Maximum price')", /<label for="([^"]+)" class="sr-only">Maximum price<\/label>[\s\S]*<input id="\1"/.test(at2000));
ok("the value is shown in words above the track", at2000.includes(">Up to ₹2,000</p>"));
ok("the ends show the real cheapest and dearest prices", at2000.includes(">₹390</span>") && at2000.includes(">₹3,299</span>"));
ok("no tick marks: no datalist, no list attribute", !at2000.includes("<datalist") && !/ list="/.test(at2000));
const anyPrice = html(shop, null);
ok("with no ceiling the thumb is at the end and says 'Any price'", /aria-valuetext="Any price"[^>]*value="3300"/.test(anyPrice) && anyPrice.includes(">Any price</p>"));
ok("a hand-edited ceiling is shown as itself until the thumb moves", html(shop, 1234).includes(">Up to ₹1,234</p>"));
const css = read("app/globals.css");
ok("the thumb has a visible keyboard focus ring", /\.price-range:focus-visible::-webkit-slider-thumb/.test(css) && /\.price-range:focus-visible::-moz-range-thumb/.test(css));
ok("the input is a 44px-tall touch band", /\.price-range \{[\s\S]*?height: 44px;/.test(css));
ok("on touch screens the thumb's hit box is 44px", /@media \(pointer: coarse\) \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/.test(css));
const src = read("components/shop/PriceSlider.tsx");
ok("commits on release, after a pause, or on blur — never every pixel of a drag",
  src.includes("onPointerUp=") && src.includes("setTimeout(() => commit(pos), 400)") && src.includes("onBlur="));
ok("follows the URL by value, so a re-render mid-commit never snaps the thumb back",
  src.includes("}, [min, max, step, maxPrice]);"));
ok("no canvas, no custom role=slider", !/<canvas|role="slider"/.test(src));

console.log("\n=== the far end is a real stop (final hardening) ===");
/**
 * The HTML spec's value sanitisation for <input type=range>: stops are
 * min + k × step; a value is rounded to the nearest stop, and a stop past max
 * steps back down to the last one at or below it. This is what the browser
 * lets a thumb, a key or a finger reach.
 */
function browserStops(min: number, max: number, step: number): number[] {
  const stops: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) stops.push(Math.round(v));
  return stops;
}
const sanitise = (min: number, max: number, step: number, v: number) => {
  const stops = browserStops(min, max, step);
  const clamped = Math.min(max, Math.max(min, v));
  return stops.reduce((best, s) => (Math.abs(s - clamped) < Math.abs(best - clamped) ? s : best), stops[0]);
};
{
  // Why rounding the ends matters: the raw catalogue ends would strand the thumb.
  const raw = browserStops(390, 3299, 100);
  check("counter-example: raw ends ₹390–₹3,299 would make ₹3,290 the last reachable stop", raw[raw.length - 1], 3290);
  const stops = browserStops(shop.min, shop.max, shop.step);
  check("actual shop track: 30 stops, ₹400 … ₹3,300", [stops.length, stops[0], stops[stops.length - 1]], [30, 400, 3300]);
  check("the last reachable stop IS the max", stops[stops.length - 1] === shop.max, true);
  check("…and it means Any price (no ceiling)", ceilingFor(shop, stops[stops.length - 1]), null);
  check("dragging past the end sanitises to the max, i.e. Any price", ceilingFor(shop, sanitise(shop.min, shop.max, shop.step, 99999)), null);
  check("End key (= max) is Any price", ceilingFor(shop, shop.max), null);
  check("one stop short of the end is the last real ceiling (₹3,200)", ceilingFor(shop, stops[stops.length - 2]), 3200);
  check("the ₹3,299 saree is excluded only at ₹3,200, never at the end", [3299 <= 3200, ceilingFor(shop, shop.max)], [false, null]);

  // Property check over generated catalogues, across all three step sizes.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let bad = 0;
  let tried = 0;
  for (let i = 0; i < 600; i++) {
    const n = 2 + Math.floor(rand() * 12);
    const scale = [4_000, 30_000, 120_000][i % 3];
    const prices = Array.from({ length: n }, () => 1 + Math.floor(rand() * scale));
    const r = priceSliderRange(prices);
    if (!r) continue;
    tried++;
    const s = browserStops(r.min, r.max, r.step);
    const okEnds = (r.max - r.min) % r.step === 0 && s[s.length - 1] === r.max && ceilingFor(r, r.max) === null;
    const okLow = r.min >= r.lowest && r.min - r.lowest < r.step;
    const okHigh = r.max >= r.highest && r.max - r.highest < r.step;
    if (!okEnds || !okLow || !okHigh) bad++;
  }
  check(`${tried} generated catalogues: the far end is always a reachable stop meaning Any price`, bad, 0);
}

console.log("\n=== malformed and stale URLs ===");
const parsed = (q: Record<string, string | string[]>) => parseCatalogueParams(q).maxPrice;
check("maxPrice=0 → no ceiling", parsed({ maxPrice: "0" }), null);
check("maxPrice=-100 → no ceiling", parsed({ maxPrice: "-100" }), null);
check("maxPrice=abc → no ceiling", parsed({ maxPrice: "abc" }), null);
check("duplicate maxPrice → the first", parsed({ maxPrice: ["1500", "9000"] }), 1500);
check("maxPrice=999999 → kept as written (filters nothing out)", parsed({ maxPrice: "999999" }), 999999);
check("…its thumb sits at the end", sliderPosition(shop, 999999), shop.max);
check("…and the slider reads Any price there, honestly", ceilingFor(shop, sliderPosition(shop, 999999)), null);
check("maxPrice=1777 (off-stop, old link) is preserved exactly — not rounded", parsed({ maxPrice: "1777" }), 1777);
check("…the browser draws its thumb at the nearest stop, ₹1,800", sanitise(shop.min, shop.max, shop.step, 1777), 1800);
ok("…the slider still labels it 'Up to ₹1,777' until moved", html(shop, 1777).includes(">Up to ₹1,777</p>"));
check("…and moving the thumb snaps to stops from there (one right = ₹1,900)", ceilingFor(shop, 1800 + shop.step), 1900);
ok("a click on the thumb that moves nothing never commits (so ₹1,777 is not silently rewritten)",
  /onPointerUp=\{\(e\) => \{\s*if \(timer\.current\) commit/.test(src));
check("a ceiling below the first stop: thumb at the first stop, filter as written",
  [sliderPosition(shop, 100), parsed({ maxPrice: "100" })], [400, 100]);

console.log("\n=== the domain comes from the scope, never the price-filtered result ===");
{
  const shopPage = read("app/(storefront)/in/shop/page.tsx");
  ok("shop: the range is built from `scope`, which is the UNFILTERED catalogue (or its chosen sub-category)",
    shopPage.includes("priceSliderRange(scope.map((p) => shownPrice(p)))") &&
    shopPage.includes("const catalogue = everything?.products ?? matched;") &&
    /isUnfiltered\(filters\) \? null : getCatalogue\(catalogueQuery\(NO_FILTERS\)\)/.test(shopPage) &&
    /const scope = chosenCategory\s*\? catalogue\.filter/.test(shopPage));
  const cat = read("components/shop/CategoryFilters.tsx");
  ok("category pages: the range is built from every product on the page, not the filtered `shown`",
    cat.includes("priceRange: priceSliderRange(products.map((p) => shownPrice(p)))") &&
    !/priceSliderRange\(shown/.test(cat));
  const SAREE_PRICES = [1250, 1299, 1399, 1499, 1599, 3299];
  const full = priceSliderRange(SAREE_PRICES)!;
  check("sarees: ₹1,300 → ₹3,300 whatever ceiling is chosen", [full.min, full.max], [1300, 3300]);
  check("at 'Up to ₹2,000' the thumb has room to go back up to the end", [sliderPosition(full, 2000) < full.max, ceilingFor(full, full.max)], [true, null]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

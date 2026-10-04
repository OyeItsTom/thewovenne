/**
 * The product page's mobile sticky Add to Cart: hidden over the real button,
 * shown below it, hidden again once the site footer comes into view.
 *
 *   npx tsx scripts/sticky-cta.test.ts
 *
 * The rule is checked against a scroll down the page and back up (states A–G
 * from the review on an iPhone). The wiring is checked as a source contract;
 * the rendered behaviour was exercised in a browser at 390px and is recorded
 * in the pull request. Exits non-zero on failure.
 */
import { readFileSync } from "node:fs";
import { showStickyCta } from "../lib/stickyCta";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else fail++;
}

console.log("\n=== a scroll down the product page and back ===");

// What the two observers report at each point. ctaHasBeenSeen latches true
// the first time the real button is on screen, as it does in the component.
const journey: { state: string; ctaVisible: boolean; footerVisible: boolean; expect: boolean }[] = [
  { state: "A  purchase area on screen", ctaVisible: true, footerVisible: false, expect: false },
  { state: "B  just below the purchase area", ctaVisible: false, footerVisible: false, expect: true },
  { state: "C  middle of the page (details, care)", ctaVisible: false, footerVisible: false, expect: true },
  { state: "D  reviews / recommendations, footer not yet in view", ctaVisible: false, footerVisible: false, expect: true },
  { state: "E  footer begins entering the viewport", ctaVisible: false, footerVisible: true, expect: false },
  { state: "E′ deep in the footer", ctaVisible: false, footerVisible: true, expect: false },
  { state: "F  scrolled back up, footer has left", ctaVisible: false, footerVisible: false, expect: true },
  { state: "G  back at the real Add to Cart", ctaVisible: true, footerVisible: false, expect: false },
];
let seen = false;
for (const step of journey) {
  if (step.ctaVisible) seen = true;
  const shown = showStickyCta({ ctaHasBeenSeen: seen, ctaVisible: step.ctaVisible, footerVisible: step.footerVisible });
  check(`${step.state} → ${step.expect ? "VISIBLE" : "hidden"}`, shown === step.expect);
}

console.log("\n=== edges ===");
check(
  "a page that loads already scrolled past the button shows no bar until the button has been seen",
  !showStickyCta({ ctaHasBeenSeen: false, ctaVisible: false, footerVisible: false })
);
check(
  "a short page where button and footer are both on screen: hidden",
  !showStickyCta({ ctaHasBeenSeen: true, ctaVisible: true, footerVisible: true })
);

console.log("\n=== wiring ===");
const options = readFileSync("components/product/ProductOptions.tsx", "utf8");
const footer = readFileSync("components/layout/Footer.tsx", "utf8");

check("the site footer carries the explicit marker", /<footer data-site-footer /.test(footer));
check("the marker is used once (only one boundary)", (footer.match(/data-site-footer/g) ?? []).length === 2 /* comment + attribute */);
check("the bar reads the shared rule", /showStickyCta\(\{ ctaHasBeenSeen, ctaVisible, footerVisible \}\)/.test(options));
check("the footer is found by the marker, not by tag", /document\.querySelector\(SITE_FOOTER_SELECTOR\)/.test(options));
check("the footer is watched by an IntersectionObserver", /new IntersectionObserver\(\(\[entry\]\) =>\s*setFooterVisible\(entry\.isIntersecting\)/.test(options));
check("no scroll listener, no hard-coded scroll position", !/addEventListener\("scroll"/.test(options) && !/scrollY|pageYOffset/.test(options));
check("both observers are disconnected on unmount", (options.match(/observer\.disconnect\(\)/g) ?? []).length >= 2);
check(
  "the bar's look is untouched (classes as shipped in this PR)",
  options.includes(
    'className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-ink/10 bg-cream/95 py-3 pl-4 pr-24 backdrop-blur lg:hidden"'
  ) &&
    options.includes(
      'className="shrink-0 rounded-full bg-terracotta-dark px-6 py-3 text-sm font-medium text-cream transition-colors hover:bg-terracotta-deep disabled:cursor-not-allowed disabled:bg-linen disabled:text-ink-muted"'
    )
);
check("still mobile-only (lg:hidden), so desktop is unaffected", /backdrop-blur lg:hidden"/.test(options));
check("quick add still adds one of the selected size and opens the cart", /quickAdd = \(\) => \{\s*addItem\(/.test(options) && /openCart\(\);/.test(options));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

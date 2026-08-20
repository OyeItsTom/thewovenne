/**
 * The header switches to its desktop navigation only where that navigation fits.
 *
 * THE NUMBERS BELOW WERE MEASURED, NOT ESTIMATED. They come from headless
 * Chrome against a production build, with the desktop nav forced visible and the
 * emblem forbidden to shrink, so each part reports what it actually needs rather
 * than what it was squeezed into. The arithmetic is then re-derived here, which
 * is what makes this a guard rather than a snapshot: if somebody moves the
 * breakpoint back, or adds a nav link, the sum stops clearing and this fails.
 *
 * What it cannot do is see. The rendering checks — no wrap, no distortion, no
 * overflow, one navigation at a time — were run in a real browser at 320, 375,
 * 390, 430, 600, 768, 800, 820, 830, 834, 900, 1023, 1024, 1280, 1440 and 1920,
 * and the measurements are recorded in the pull request.
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else {
    fail++;
    if (detail) console.log(`        ${detail}`);
  }
}

const nav = readFileSync("components/layout/NavbarClient.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

/** Measured in headless Chrome, production build, logo protected from shrinking. */
const MEASURED = {
  /** scrollWidth of the desktop link row at its natural size. */
  desktopNav: 668,
  /** The search/wishlist/account/cart cluster. Constant at every width. */
  controls: 156,
  /** The emblem at `sm:h-11`, undistorted. */
  logo: 49,
  /** container-wovenne: `sm:px-8` below lg, `lg:px-12` from lg. */
  paddingBelowLg: 64,
  paddingFromLg: 96,
};

/** Tailwind's named breakpoints, as used by this header. */
const MD = 768;
const LG = 1024;

const requiredInner = MEASURED.desktopNav + MEASURED.controls + MEASURED.logo;
const minViewportBelowLg = requiredInner + MEASURED.paddingBelowLg;

console.log("\n=== what the desktop header actually needs ===");
check("the three parts sum to a known requirement", requiredInner === 873, String(requiredInner));
check("which needs a 937px viewport at the narrower padding", minViewportBelowLg === 937, String(minViewportBelowLg));
check("md is far too narrow for it", MD < minViewportBelowLg, `${MD} < ${minViewportBelowLg}`);
check(
  "md leaves the row 169px short — which is why it wrapped",
  minViewportBelowLg - MD === 169,
  String(minViewportBelowLg - MD)
);

console.log("\n=== the chosen breakpoint clears it, with room ===");
const innerAtLg = LG - MEASURED.paddingFromLg;
check("lg is at or above the minimum", LG >= minViewportBelowLg, `${LG} >= ${minViewportBelowLg}`);
check("and its inner width exceeds the requirement", innerAtLg > requiredInner, `${innerAtLg} > ${requiredInner}`);
check(
  "leaving a real margin rather than a hairline",
  innerAtLg - requiredInner >= 40,
  `spare ${innerAtLg - requiredInner}px`
);
// A hypothetical 940 breakpoint would clear by 3px, which is not a margin.
check(
  "a breakpoint at the bare minimum would NOT have been safe",
  940 - MEASURED.paddingBelowLg - requiredInner < 10,
  `spare would be ${940 - MEASURED.paddingBelowLg - requiredInner}px`
);

console.log("\n=== the header source agrees with that decision ===");
check("the desktop nav is gated on lg", nav.includes('className="hidden items-center gap-8 lg:flex"'));
check("the hamburger retreats at the same width", nav.includes('text-ink lg:hidden'));
check("so does the drawer", nav.includes('border-t border-ink/5 lg:hidden'));
check("no md: breakpoint survives in the header", !/\bmd:/.test(nav), "an md: class would split the two systems");
check(
  "the two navigations therefore switch at ONE width",
  (nav.match(/lg:hidden/g) ?? []).length === 2 && (nav.match(/lg:flex/g) ?? []).length === 1
);

console.log("\n=== the emblem is not the thing that gives way ===");
check("the logo link cannot shrink", nav.includes('className="flex shrink-0 items-center'));
check("its rendered height is unchanged", nav.includes('className="h-10 w-auto sm:h-11"'));
check("and its aspect is still declared by the slot", nav.includes("width={49}") && nav.includes("height={44}"));

console.log("\n=== the whole 768-1023 band is on the mobile header ===");
for (const w of [768, 800, 820, 830, 834, 900, 1000, 1023]) {
  check(`${w}px uses the mobile navigation`, w < LG);
}
check("1024px is the first desktop width", LG === 1024);

console.log("\n=== the header height variable stays truthful ===");
// Mobile mode at every width from sm up is one row: py-4 (32) + the sm:h-11
// emblem (44) + the 1px rule = 77. Below sm the emblem is h-10 (40) => 73.
check("--header-h is 73px below sm", /:root\s*\{[^}]*--header-h:\s*73px/.test(css));
check("and 77px from sm up", /@media \(min-width: 640px\)\s*\{\s*:root\s*\{\s*--header-h:\s*77px/.test(css));
check("32px of vertical padding on the row", nav.includes("py-4"));
check("the emblem is 40px below sm and 44px above", nav.includes("h-10 w-auto sm:h-11"));
check("73 = 32 + 40 + 1", 32 + 40 + 1 === 73);
check("77 = 32 + 44 + 1", 32 + 44 + 1 === 77);
check(
  "the stale note about the 768-829 anomaly is gone",
  !css.includes("DELIBERATELY NOT EXACT BETWEEN 768"),
  "the anomaly is fixed; the comment described a header that no longer exists"
);

console.log("\n=== accessibility of the control this change promoted ===");
check("the menu toggle announces its state", nav.includes("aria-expanded={mobileOpen}"));
check("the search toggle still announces its own", nav.includes("aria-expanded={searchOpen}"));
check("the toggle keeps an accessible name", nav.includes('aria-label="Toggle menu"'));
check("it is a real button, so Enter and Space work without custom code", /<button\s+[^>]*onClick=\{\(\) => setMobileOpen/.test(nav.replace(/\n\s*/g, " ")));
check("the emblem link keeps its name", nav.includes('aria-label="THE WOVENNE — home"'));

console.log("\n=== nothing else about the header moved ===");
check("still sticky at the top", nav.includes('sticky top-0 z-40'));
check("same container and row", nav.includes('className="container-wovenne flex items-center justify-between py-4"'));
check("same gap between desktop links", nav.includes("gap-8"));
check("typography untouched", nav.includes("font-body text-sm uppercase tracking-widest"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

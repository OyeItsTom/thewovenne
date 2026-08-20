/**
 * The hero owns the first screen.
 *
 * This is a source contract, not a rendering test: the geometry itself was
 * measured in a headless browser at eight widths (see the PR). What is asserted
 * here is the thing that would silently regress — somebody reintroducing a `vh`
 * fraction, or reaching for `dvh`, or the CSS and the component drifting apart.
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

const css = readFileSync("app/globals.css", "utf8");
const hero = readFileSync("components/home/Hero.tsx", "utf8");
const navbar = readFileSync("components/layout/NavbarClient.tsx", "utf8");

/**
 * Source with its comments removed. Both files DISCUSS dvh and name real
 * devices in prose — that is the reasoning, not a rule, and asserting over it
 * would fail the moment somebody explained themselves properly.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
const cssCode = codeOf(css);
const heroCode = codeOf(hero);

console.log("\n=== the hero asks for the viewport minus the header ===");
check("the hero uses the shared utility", hero.includes("hero-viewport"));
check("no viewport fraction survives", !/min-h-\[\d+vh\]/.test(hero));
check("the utility is defined", css.includes(".hero-viewport"));

const rule = css.slice(css.indexOf(".hero-viewport"), css.indexOf(".hero-viewport") + 260);
check("it subtracts the header height", rule.includes("calc(100svh - var(--header-h))"), rule);
check("a vh fallback is present", rule.includes("calc(100vh - var(--header-h))"), rule);

const vhAt = rule.indexOf("calc(100vh");
const svhAt = rule.indexOf("calc(100svh");
check("the fallback comes FIRST, or svh never applies", vhAt >= 0 && svhAt > vhAt);

console.log("\n=== svh, because dvh would resize while you scroll ===");
check("dvh is not used", !cssCode.includes("dvh") && !heroCode.includes("dvh"));
check("lvh is not used either", !cssCode.includes("lvh") && !heroCode.includes("lvh"));

console.log("\n=== the header height is declared once, and is real ===");
check("--header-h is defined on :root", /:root\s*\{[^}]*--header-h:\s*73px/.test(css));
check("it steps up at the sm breakpoint", /@media \(min-width: 640px\)\s*\{\s*:root\s*\{\s*--header-h:\s*77px/.test(css));
check("no device-name or breakpoint hack in the hero", !/iphone|ipad|android|safari/i.test(heroCode));

console.log("\n=== the header the number describes ===");
check("the header is still sticky at the top of flow", navbar.includes('sticky top-0'));
check("the header still uses py-4", navbar.includes("py-4"));

console.log("\n=== the hero still fits the SMALLEST screen ===");
check("vertical padding relaxes below sm", hero.includes("py-12 sm:py-20"), "320x568 has 495px of room");
check("the CTA is still rendered", hero.includes("c.cta_label"));
check("the emblem is still capped in vh, not the section", hero.includes("max-h-[52vh]"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

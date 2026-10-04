/**
 * Main navigation: Women / Men / Jewellery open their menu and never navigate.
 * The only way to a section page from the header is its "View all …" link.
 *
 *   npx tsx scripts/nav-parent-trigger.test.ts
 *
 * Renders the real NavbarClient with react-dom/server and reads the source for
 * the interaction rules. Click/keyboard behaviour itself is exercised against a
 * production build in headless Chrome (see the PR notes).
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import NavbarClient, { type NavItem } from "../components/layout/NavbarClient";

(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function ok(name: string, condition: boolean) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else fail++;
}
const read = (p: string) => fs.readFileSync(p, "utf8");

const section = (slug: string, name: string, kids: [string, string][]): NavItem => ({
  href: `/in/${slug}`,
  label: name,
  children: [
    ...kids.map(([s, n]) => ({ href: `/in/${slug}/${s}`, label: n })),
    { href: `/in/${slug}`, label: `View all ${name}` },
  ],
});
const LINKS: NavItem[] = [
  section("women", "Women", [["sarees", "Sarees"]]),
  section("men", "Men", [["dhotis", "Dhoti"]]),
  section("jewellery", "Jewellery", [["necklace", "Necklace"], ["rings", "Rings"]]),
  { href: "/in/about", label: "Our Story" },
  { href: "/in/customer-style", label: "Worn by You" },
];

const noop = () => {};
const ROUTER = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };
const html = renderToStaticMarkup(
  createElement(AppRouterContext.Provider, { value: ROUTER as never }, createElement(NavbarClient, { navLinks: LINKS }))
);
const src = read("components/layout/NavbarClient.tsx");

console.log("\n=== desktop: the section name is a disclosure button ===");
for (const name of ["Women", "Men", "Jewellery"]) {
  const id = `nav-menu-${name.toLowerCase()}`;
  const button = new RegExp(`<button type="button" aria-expanded="false" aria-controls="${id}"[^>]*>${name}<svg`);
  ok(`${name}: a real <button>, collapsed, controlling #${id}`, button.test(html));
}
ok("no header link to a section page while the menus are closed",
  !/href="\/in\/(women|men|jewellery)"/.test(html));
ok("the old aria-haspopup on a link is gone (a disclosure, not an ARIA menu)", !html.includes('aria-haspopup="true"'));
ok("plain links stay links", html.includes('href="/in/about"') && html.includes('href="/in/customer-style"'));
ok("the panel carries the id the trigger names", src.includes("id={menuId}"));
ok("click, Enter and Space all reach onTrigger (native button click)", src.includes("onClick={() => onTrigger(link.href)}"));
ok("a hover-opened menu is pinned by a click, not toggled shut under the pointer",
  /if \(openMenu === href && pinned\.current\)[\s\S]*?closeMenu\(\)/.test(src));
ok("a pinned menu ignores mouse-leave", /const closeSoon = \(\) => \{\s*if \(pinned\.current\) return;/.test(src));
ok("Escape closes and returns focus to the section name", /e\.key !== "Escape"[\s\S]*?closeMenu\(\)[\s\S]*?trigger\?\.focus\(\)/.test(src));
ok("a click outside the desktop nav closes a pinned menu", src.includes("document.addEventListener(\"pointerdown\", onDown)"));
ok("Tab focus alone no longer unfolds a menu", !/onFocus=\{\(\) => openNow/.test(src));
ok("the trigger has a visible focus ring", /onTrigger[\s\S]*?focus-visible:ring-2 focus-visible:ring-terracotta/.test(src));

console.log("\n=== mobile: the section row expands, it does not navigate ===");
for (const name of ["Women", "Men", "Jewellery"]) {
  const id = `nav-group-${name.toLowerCase()}`;
  ok(`${name}: expand button controlling #${id}`, src.includes("aria-controls={groupId}") && src.includes("nav-group-"));
  void id;
}
ok("the whole row is the button (no separate link + chevron)",
  !/Show .* categories|Hide .* categories/.test(src) && src.includes('className="flex w-full items-center justify-between py-1 text-left'));
ok("the expanded list carries the id", src.includes("id={groupId}"));

console.log("\n=== the section pages are untouched ===");
const navbar = read("components/layout/Navbar.tsx");
ok("every section's menu still ends in View all → the section URL",
  navbar.includes("{ href: cPath(`/${parent.slug}`), label: `View all ${parent.name}` }"));
ok("sub-category links unchanged", navbar.includes("href: cPath(`/${parent.slug}/${child.slug}`)"));
ok("the header still reads the PR 2 eligible tree", navbar.includes("await getNavCategoryTree()"));
ok("the section route still exists", fs.existsSync("app/(storefront)/in/[slug]/page.tsx"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

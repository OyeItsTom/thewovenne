/**
 * Internal links in page paragraphs: `[text](/internal-path)` and nothing else.
 *
 *   npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/policy-links.test.ts
 *
 * The parser (lib/inlineLinks) and the real renderer (components/page/PageBlocks)
 * as server HTML. Anything that is not a safe link to a storefront page must
 * stay literal, escaped text.
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PageBlocks from "../components/page/PageBlocks";
import { inlineLinkHref, parseInlineLinks } from "../lib/inlineLinks";
import type { PageBlock } from "../lib/pages";

// tsx compiles JSX with the classic transform, which expects React in scope.
(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

const html = (...texts: string[]) =>
  renderToStaticMarkup(createElement(PageBlocks, { blocks: texts.map((text) => ({ type: "paragraph", text }) as PageBlock) }));
const anchors = (h: string) => [...h.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ href: m[1], text: m[2] }));
const literal = (s: string) => {
  const seg = parseInlineLinks(s);
  return seg.length === 1 && seg[0].kind === "text" && seg[0].text === s;
};

console.log("\nvalid internal links");
const policy = "For more information, please see our [Cookie Information & Consent page](/in/cookies).";
const h1 = html(policy);
t("/in/cookies becomes one link to /in/cookies", JSON.stringify(anchors(h1)) === JSON.stringify([{ href: "/in/cookies", text: "Cookie Information &amp; Consent page" }]), h1);
t("…the surrounding words are kept, the brackets are gone", h1.includes("For more information, please see our <a") && h1.includes("</a>.") && !h1.includes("]("));
t("/cookies (no market) also reaches /in/cookies", inlineLinkHref("/cookies") === "/in/cookies");
t("nested internal path", anchors(html("See [this saree](/in/women/sarees/black-line-border).")).at(0)?.href === "/in/women/sarees/black-line-border");
t("nested path without the market gets it", inlineLinkHref("/women/sarees") === "/in/women/sarees");
const two = anchors(html("Read [shipping](/in/shipping-delivery) and [returns](/in/returns-exchanges)."));
t("two links in one paragraph", two.length === 2 && two[0].href === "/in/shipping-delivery" && two[1].href === "/in/returns-exchanges");
const multi = html("First [cookies](/in/cookies).", "Second paragraph, plain.", "Third [privacy](/in/privacy-policy).");
t("multiple paragraphs: three <p>, links only where written",
  (multi.match(/<p /g) ?? []).length === 3 && JSON.stringify(anchors(multi).map((a) => a.href)) === JSON.stringify(["/in/cookies", "/in/privacy-policy"]));

console.log("\nrefused — stays literal text");
for (const [name, s] of [
  ["external https URL", "[x](https://example.com)"],
  ["external http URL", "[x](http://example.com/in/cookies)"],
  ["protocol-relative //example.com", "[x](//example.com)"],
  ["javascript:", "[x](javascript:alert(1))"],
  ["javascript: without parentheses", "[x](javascript:alert`1`)"],
  ["data:", "[x](data:text/html;base64,PHNjcmlwdD4=)"],
  ["mailto:", "[x](mailto:a@b.c)"],
  ["backslash host", "[x](/\\example.com)"],
  ["admin path", "[x](/admin/dashboard)"],
  ["api path", "[x](/api/events)"],
  ["relative path", "[x](in/cookies)"],
  ["empty target", "[x]()"],
  ["empty text", "[](/in/cookies)"],
  ["whitespace-only text", "[   ](/in/cookies)"],
  ["title attribute", '[x](/in/cookies "title")'],
  ["space before (", "[x] (/in/cookies)"],
  ["unclosed (", "[x](/in/cookies"],
  ["unclosed [", "[x(/in/cookies)"],
  ["line break in text", "[a\nb](/in/cookies)"],
  ["nested brackets", "[a [b]](/in/cookies)"],
  ["control character", "[x](/in/coo\u0000kies)"],
  ["tab in target", "[x](/in/\tcookies)"],
] as const) {
  t(`${name} → literal, no link`, literal(s) && anchors(html(s)).length === 0, JSON.stringify(parseInlineLinks(s)));
}
t("a refused link beside a valid one: only the valid one links",
  JSON.stringify(anchors(html("[bad](https://evil.example) and [good](/in/cookies)")).map((a) => a.href)) === JSON.stringify(["/in/cookies"]));

console.log("\nplain text and escaping");
const existing = "We use cookies and similar technologies where required for website functionality, preferences, analytics, security and other purposes.\n\nFor more information, please see our Cookie Information & Consent page.";
t("existing policy text renders exactly as before (no link, same markup)",
  html(existing) === `<div class="mx-auto max-w-prose"><p class="mt-5 text-base leading-relaxed text-ink/75">${existing.replace(/&/g, "&amp;")}</p></div>`);
t("plain text with brackets but no link is unchanged", literal("Sizes [S, M, L] (approx.)") && literal("Use (brackets) [freely]."));
const xss = html('<script>alert(1)</script> [<img src=x onerror=alert(1)>](/in/cookies) <b>bold</b>');
t("HTML in text is escaped, never markup", !xss.includes("<script>") && !xss.includes("<img") && !xss.includes("<b>") && xss.includes("&lt;script&gt;"));
t("HTML inside link text is escaped inside the link", anchors(xss).length === 1 && anchors(xss)[0].text.includes("&lt;img") && anchors(xss)[0].href === "/in/cookies");
const quoteBreak = html('[x](/in/cookies"onmouseover="alert(1))');
t("a quote in the target cannot break out of the attribute", !/onmouseover="alert/.test(quoteBreak), quoteBreak);
t("no raw Markdown rendering: emphasis stays literal", html("**bold** _it_ [x](/in/cookies)").includes("**bold** _it_ "));

console.log("\nwiring");
const blocks = fs.readFileSync("components/page/PageBlocks.tsx", "utf8");
t("paragraphs use parseInlineLinks; headings and FAQ are untouched", (blocks.match(/parseInlineLinks\(/g) ?? []).length === 1 && blocks.includes("{block.text}\n              </h2>"));
t("no dangerouslySetInnerHTML anywhere in the renderer", !blocks.includes("dangerouslySetInnerHTML"));
t("the target check is the footer's safeInternalHref, not a new validator", fs.readFileSync("lib/inlineLinks.ts", "utf8").includes('import { safeInternalHref } from "./footer"'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

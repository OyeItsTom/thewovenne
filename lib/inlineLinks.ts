import { adminHref, isUnprefixed } from "./country";
import { safeInternalHref } from "./footer";

/**
 * Internal links inside a page paragraph — `[visible text](/in/cookies)` — and
 * nothing else.
 *
 * Paragraphs typed in Admin → Pages are plain text, rendered by React, so
 * nothing typed there can become markup. This adds exactly one capability on
 * top: a link to a page of THIS site, written in the one bit of Markdown
 * people already know. It is not a Markdown renderer. There is no HTML, no
 * emphasis, no images, no external links.
 *
 * The target must pass safeInternalHref (lib/footer) — the same check the
 * footer's Explore links already use: a leading "/", not "//", no backslash,
 * no whitespace or control characters. That alone refuses https:, mailto:,
 * javascript: and data:. It must also be a storefront page: /admin, /api and
 * the other unprefixed system paths are refused. A target written without the
 * market ("/cookies") gets it added, like every other admin-typed link
 * (adminHref), so "/cookies" and "/in/cookies" both reach /in/cookies.
 *
 * ANYTHING THAT DOES NOT QUALIFY STAYS EXACTLY AS TYPED, as plain text, so a
 * mistake is visible on the page instead of silently vanishing.
 */
export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

// Visible text: 1–200 characters, no brackets or line breaks.
// Target: 1–300 characters, no parentheses or whitespace (a title, a space or
// a nested "(" means it is not this syntax, so it stays literal).
const LINK = /\[([^[\]\r\n]{1,200})\]\(([^()\s]{1,300})\)/g;

/** The href a link target becomes, or null if it may not be a link. */
export function inlineLinkHref(target: string): string | null {
  const safe = safeInternalHref(target);
  if (!safe || safe !== target) return null;
  if (isUnprefixed(safe)) return null;
  return adminHref(safe);
}

export function parseInlineLinks(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const start = m.index ?? 0;
    push(text.slice(at, start));
    const label = m[1].trim();
    const href = label ? inlineLinkHref(m[2]) : null;
    if (href) out.push({ kind: "link", text: label, href });
    else push(m[0]);
    at = start + m[0].length;
  }
  push(text.slice(at));
  return out;
}

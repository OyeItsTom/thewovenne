/**
 * WP-EMAIL-E1 — the shared email layout (lib/emails/layout.ts).
 *
 * Proves what is not a matter of taste:
 *   1. escaping: every plain string is escaped, in text and in attributes;
 *      only markup the module built passes through;
 *   2. links: only the shop's own https origin, paths on it, or mailto;
 *   3. branding: the r4 header (deployed v1 emblem, alt text, wordmark,
 *      tagline, terracotta rule) and Ink buttons, no terracotta behind text;
 *   4. document structure: lang, charset, viewport, title, preheader,
 *      560px column, presentation tables, nothing a mail client strips;
 *   5. footers: transactional never mentions marketing or unsubscribing;
 *      marketing always says why and how to stop;
 *   6. no tracking: one image, no scripts, no external hosts.
 *
 *   npx tsx scripts/email-layout.test.ts
 *
 * Pure functions. Sends nothing, touches no database. Exits non-zero on failure.
 */
import {
  BRAND,
  CLOSING_TEXT,
  EMAIL_COLORS,
  EMAIL_ORIGIN,
  EMBLEM_URL,
  button,
  closing,
  escapeHtml,
  firstName,
  footer,
  footerText,
  greeting,
  greetingText,
  heading,
  html,
  infoBox,
  link,
  paragraph,
  renderEmail,
  safeHref,
  strong,
  type EmailFooter,
  type SafeHtml,
} from "../lib/emails/layout";
import * as layout from "../lib/emails/layout";

let passed = 0;
let failed = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const count = (hay: string, needle: string | RegExp) =>
  typeof needle === "string" ? hay.split(needle).length - 1 : (hay.match(needle) ?? []).length;

const EVIL = `<script>alert("x")</script><img src=x onerror='y'> & "quoted"`;
const EVIL_ESCAPED =
  "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;y&#39;&gt; &amp; &quot;quoted&quot;";

const transactional: EmailFooter = { kind: "transactional" };
const marketing: EmailFooter = {
  kind: "marketing",
  reason: "You're receiving this because you asked for updates when you created your account.",
  preferencesHref: "/in/account/settings",
};

function sample(footerKind: EmailFooter = transactional, name: string | null = "Ananya Rao") {
  return renderEmail({
    title: "Your THE WOVENNE order — 1A2B3C4D",
    preheader: "We've received your order and we're preparing it now.",
    body: [
      heading("Thank you for your order"),
      greeting(name),
      paragraph(html`Order ${strong("1A2B3C4D")} is being prepared.`),
      infoBox(html`Order reference ${strong("1A2B3C4D")}`),
      button({ href: "/in/account/orders", label: "View your order" }),
      closing(),
    ],
    footer: footerKind,
  });
}

// ── 1. Escaping ─────────────────────────────────────────────────────────────
console.log("\n1. Escaping");
t("escapeHtml escapes & < > \" '", escapeHtml(EVIL) === EVIL_ESCAPED, escapeHtml(EVIL));
t("escapeHtml(null/undefined) is empty", escapeHtml(null) === "" && escapeHtml(undefined) === "");
t("escapeHtml(number) stringifies", escapeHtml(42) === "42");
t("escapeHtml does not double-escape only once applied", escapeHtml("&amp;") === "&amp;amp;");
t("html`` escapes interpolated strings", String(html`<b>${EVIL}</b>`) === `<b>${EVIL_ESCAPED}</b>`);
t("html`` passes SafeHtml through", String(html`<p>${strong("x")}</p>`).includes("<strong"));
t("html`` joins arrays and drops null/false", String(html`${["a", null, false, html`<i>b</i>`, undefined, 1]}`) === "a<i>b</i>1");
t("a plain string that looks like markup is not markup", !String(html`${"<b>x</b>"}`).includes("<b>"));

const evilDoc = renderEmail({
  title: EVIL,
  preheader: EVIL,
  body: [
    heading(EVIL),
    greeting(EVIL),
    paragraph(EVIL),
    paragraph(EVIL, { tone: "small" }),
    paragraph(html`x ${strong(EVIL)}`),
    infoBox(EVIL),
    button({ href: "/in", label: EVIL }),
    paragraph(html`see ${link("/in", EVIL)}`),
  ],
  footer: { kind: "marketing", reason: EVIL, preferencesHref: "/in/account/settings" },
});
t("no raw <script> anywhere in a document built from hostile input", !/<script/i.test(evilDoc));
t("no raw onerror attribute", !/<img[^>]*onerror/i.test(evilDoc));
t("only one <img> (the emblem)", count(evilDoc, /<img\b/gi) === 1);
t("hostile input appears escaped (title, preheader, heading, …)", count(evilDoc, "&lt;script&gt;") >= 9, String(count(evilDoc, "&lt;script&gt;")));

// Runtime guard: a JS caller passing a raw string as a body section.
const rawSection = renderEmail({
  title: "t",
  preheader: "p",
  body: ["<script>x</script>" as unknown as SafeHtml],
  footer: transactional,
});
t("a raw string smuggled into body[] is escaped, not injected", !rawSection.includes("<script>x"));

// Review fixes (pre-commit): no way to mint trusted markup from outside.
t("SafeHtml is not exported as a value (cannot be forged with new)", !("SafeHtml" in layout));
const forged = { toString: () => "<script>forged</script>" } as unknown as SafeHtml;
t("an object pretending to be SafeHtml is escaped", !String(html`${forged}`).includes("<script>"));
const spaceInjection = String(paragraph("x", { spaceAfter: '0;"><script>x</script>' as unknown as number }));
t("paragraph spaceAfter cannot inject markup (non-number)", !spaceInjection.includes("<script>") && spaceInjection.includes("padding-bottom:0px"));
t("paragraph spaceAfter is clamped 0–80", String(paragraph("x", { spaceAfter: 500 })).includes("padding-bottom:80px") && String(paragraph("x", { spaceAfter: -3 })).includes("padding-bottom:0px"));
t("paragraph spaceAfter NaN/Infinity → 0", String(paragraph("x", { spaceAfter: NaN })).includes("padding-bottom:0px") && String(paragraph("x", { spaceAfter: Infinity })).includes("padding-bottom:0px"));

// ── 2. Links ────────────────────────────────────────────────────────────────
console.log("2. Links");
t("path → production origin", safeHref("/in/account/orders") === `${EMAIL_ORIGIN}/in/account/orders`);
t("own https origin accepted", safeHref("https://www.thewovenne.com/in/cart") === "https://www.thewovenne.com/in/cart");
t("apex host accepted", safeHref("https://thewovenne.com/in") === "https://thewovenne.com/in");
t("query string preserved", safeHref("/in/x?a=1&b=2") === `${EMAIL_ORIGIN}/in/x?a=1&b=2`);
t("mailto accepted", safeHref("mailto:hello@thewovenne.com") === "mailto:hello@thewovenne.com");
for (const bad of [
  "",
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "data:text/html,<script>",
  "http://www.thewovenne.com/in",
  "https://evil.example/in",
  "https://www.thewovenne.com.evil.example/",
  "https://evil.example/?https://www.thewovenne.com",
  "https://user:pw@www.thewovenne.com/",
  "https://www.thewovenne.com:8443/",
  "//evil.example/x",
  "/\\evil.example",
  "in/account",
  "/in/acc ount",
  "/in/\naccount",
  "mailto:hello@thewovenne.com?subject=hi",
  "mailto:not-an-address",
  "https://vercel-preview-abc.vercel.app/in",
]) {
  t(`refused: ${JSON.stringify(bad)}`, throws(() => safeHref(bad)));
}
t("root path", safeHref("/") === `${EMAIL_ORIGIN}/`);
t("fragment preserved", safeHref("/in/account/settings#marketing") === `${EMAIL_ORIGIN}/in/account/settings#marketing`);
t("uppercase host normalised", safeHref("https://WWW.THEWOVENNE.COM/x") === "https://www.thewovenne.com/x");
t("non-ASCII path percent-encoded", safeHref("/in/café") === `${EMAIL_ORIGIN}/in/caf%C3%A9`);
t("zero-width char in path percent-encoded", !safeHref("/in/\u200bx").includes("\u200b") && safeHref("/in/\u200bx").includes("%E2%80%8B"));
t("bidi override in path percent-encoded", !safeHref("/in/\u202ex").includes("\u202e") && safeHref("/in/\u202ex").includes("%E2%80%AE"));
t("encoded slashes stay a path on our origin", safeHref("/in/%2F%2Fevil.example").startsWith(`${EMAIL_ORIGIN}/in/`));
t("dot segments resolve on our origin", safeHref("/in/../../../x") === `${EMAIL_ORIGIN}/x`);
t("quote in path is percent-encoded", safeHref('/in/"x').includes("%22"));
for (const bad of [
  "https://www.thewovenne.com./x",
  "https://www.thewovenne.com%2F@evil.example",
  "https://evil.example\\@www.thewovenne.com",
  "https://evil.example#@www.thewovenne.com",
  "https://xn--thewovenne-xyz.com/",
  "https://www.thewovenne.com\u00a0/x",
  "\u2028/in",
  "mailto:someone@evil.example",
  "mailto:hello@thewovenne.com,someone@evil.example",
  "mailto:hello%40evil.example@thewovenne.com",
  "mailto:hello@thewovenne.com.evil.example",
  "MAILTO:hello@thewovenne.com",
  "ftp://www.thewovenne.com/",
  "blob:https://www.thewovenne.com/x",
  "vbscript:x",
]) {
  t(`refused: ${JSON.stringify(bad)}`, throws(() => safeHref(bad)));
}
t("orders@ mailto accepted", safeHref("mailto:orders@thewovenne.com") === "mailto:orders@thewovenne.com");
t("today's env-built localhost URLs are refused (convert callers to paths)", throws(() => safeHref("http://localhost:3000/in/account/orders")));
t("button refuses a foreign href", throws(() => button({ href: "https://evil.example", label: "x" })));
t("link refuses a foreign href", throws(() => link("javascript:x", "x")));
t("marketing footer refuses a foreign preferences link", throws(() => footer({ kind: "marketing", reason: "r", preferencesHref: "https://evil.example" })));
t(
  "href with & is attribute-escaped",
  String(button({ href: "/in/x?a=1&b=2", label: "Go" })).includes(`href="${EMAIL_ORIGIN}/in/x?a=1&amp;b=2"`)
);

// ── 3. Branding ─────────────────────────────────────────────────────────────
console.log("3. Branding");
const doc = sample();
t("emblem is the deployed v1 URL", EMBLEM_URL === "https://www.thewovenne.com/email/wovenne-emblem-v1.png");
t("emblem <img> present with width/height for Outlook", doc.includes(`<img src="${EMBLEM_URL}" width="90" height="81"`));
t("emblem alt text", doc.includes('alt="THE WOVENNE emblem"'));
t("alt text styled maroon for images-off", /<img[^>]*color:#640E0D/.test(doc));
t("emblem is display:block, height:auto", /<img[^>]*display:block[^>]*height:auto/.test(doc));
t("text wordmark present (image-blocked fallback)", doc.includes(`letter-spacing:2px;color:${EMAIL_COLORS.ink};">THE WOVENNE</div>`));
t("tagline present", doc.includes(">Chosen piece by piece.</div>"));
t("terracotta rule under header", doc.includes(`border-bottom:2px solid ${EMAIL_COLORS.terracotta}`));
t("terracotta used only for the rule", count(doc, EMAIL_COLORS.terracotta) === 1);
t("button is Ink with bgcolor (bulletproof)", String(button({ href: "/in", label: "x" })).includes(`bgcolor="${EMAIL_COLORS.ink}"`));
t("button text white on Ink", /bgcolor="#1C1F3B"[\s\S]*color:#ffffff/.test(String(button({ href: "/in", label: "x" }))));
t("button tap target padding 14px 28px", String(button({ href: "/in", label: "x" })).includes("padding:14px 28px"));
t("inline links Ink and underlined", String(link("/in", "x")).includes(`color:${EMAIL_COLORS.ink};text-decoration:underline`));
t("palette matches brief", EMAIL_COLORS.ink === "#1C1F3B" && EMAIL_COLORS.maroon === "#640E0D" && EMAIL_COLORS.terracotta === "#C2714F" && EMAIL_COLORS.muted === "#6B6B76");
t("brand strings", BRAND.name === "THE WOVENNE" && BRAND.tagline === "Chosen piece by piece.");
t("closing matches r4", String(closing()).includes("Kind regards,<br>The Wovenne Team") && CLOSING_TEXT === "Kind regards,\nThe Wovenne Team");
t("info box: linen background, Ink text", /bgcolor="#F0EAD6"[^>]*color:#1C1F3B/.test(String(infoBox("x"))));

// Greeting
t("greeting uses first name", greetingText("Ananya Rao") === "Hello Ananya,");
t("greeting trims whitespace", greetingText("   Ananya   ") === "Hello Ananya,");
t("greeting without a name is 'Hello,'", greetingText(null) === "Hello," && greetingText("") === "Hello," && greetingText("   ") === "Hello,");
t("never 'there'", !sample(transactional, null).includes("there,"));
t("firstName(null) is null", firstName(null) === null);
t("greeting escapes the name", String(greeting("<b>")).includes("Hello &lt;b&gt;,"));

// ── 4. Document structure ───────────────────────────────────────────────────
console.log("4. Structure");
t("doctype", doc.startsWith("<!doctype html>"));
t('lang="en"', doc.includes('<html lang="en">'));
t("charset utf-8", doc.includes('<meta charset="utf-8">'));
t("viewport", doc.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
t("color-scheme light", doc.includes('<meta name="color-scheme" content="light">'));
t("title", doc.includes("<title>Your THE WOVENNE order — 1A2B3C4D</title>"));
t("preheader hidden, first in body", /<body[^>]*>\s*<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;[^"]*">We&#39;ve received your order/.test(doc));
t("560px content column", doc.includes("max-width:560px"));
t("20px side gutter for small screens", doc.includes('padding:40px 20px'));
t("every table is role=presentation", count(doc, /<table\b/g) === count(doc, /<table role="presentation"/g));
t("body text-size-adjust", doc.includes("-webkit-text-size-adjust:100%"));
t("one h1", count(doc, /<h1\b/g) === 1);
t("no <style>, <link>, <script>, <iframe>, <form>, <svg>", !/<(style|link|script|iframe|form|svg)\b/i.test(doc));
t("no web fonts / @import / url()", !/@import|@font-face|url\(/i.test(doc));
t("no flex/grid", !/display:\s*(flex|grid)/i.test(doc));
t("no background images", !/background-image|background="/i.test(doc));
t("no font size below 12px (except preheader)", (() => {
  const sizes = [...doc.replace(/<div style="display:none[^>]*>/, "").matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));
  return sizes.filter((s) => s !== 0).every((s) => s >= 12);
})());
t("sections are rows of the column", /max-width:560px;">\s*<tr>/.test(doc));
t("tags balanced: table", count(doc, /<table\b/g) === count(doc, /<\/table>/g));
t("tags balanced: tr", count(doc, /<tr\b/g) === count(doc, /<\/tr>/g));
t("tags balanced: td", count(doc, /<td\b/g) === count(doc, /<\/td>/g));
t("tags balanced: a", count(doc, /<a\b/g) === count(doc, /<\/a>/g));
t("paragraph tones: body 15px, small 14px", String(paragraph("x")).includes("font-size:15px") && String(paragraph("x", { tone: "small" })).includes("font-size:14px"));

// ── 5. Footers ──────────────────────────────────────────────────────────────
console.log("5. Footers");
const tf = String(footer(transactional));
const sf = String(footer({ kind: "security" }));
const mf = String(footer(marketing));
const mfu = String(footer({ ...marketing, unsubscribeHref: "/in/account/settings#marketing" }));
const noMarketing = (s: string) => !/unsubscrib|preferences|marketing|receiving this because/i.test(s);
t("transactional: reply line", tf.includes("reply to this email"));
t("transactional: no marketing/unsubscribe wording", noMarketing(tf));
t("transactional: optional note escaped", String(footer({ kind: "transactional", note: "<i>n</i>" })).includes("&lt;i&gt;n&lt;/i&gt;"));
t("security: r4 wording", sf.includes("This is an account security email from"));
t("security: no marketing wording", noMarketing(sf));
t("marketing: reason shown", mf.includes("You&#39;re receiving this because you asked for updates"));
t("marketing: preferences link", mf.includes(`href="${EMAIL_ORIGIN}/in/account/settings"`) && mf.includes(">your preferences</a>"));
t("marketing: says order emails are separate", mf.includes("Order and delivery emails are separate"));
t("marketing: no unsubscribe link unless given", !/unsubscribe<\/a>/.test(mf));
t("marketing: unsubscribe link when given", mfu.includes(`href="${EMAIL_ORIGIN}/in/account/settings#marketing"`) && mfu.includes(">unsubscribe</a>"));
t("all footers ≥12px, divider", [tf, sf, mf].every((f) => f.includes("font-size:12px") && f.includes("border-top:1px solid #EEEEEE")));
t("all footers carry brand + site link", [tf, sf, mf].every((f) => f.includes(">THE WOVENNE</span>") && f.includes(`href="${EMAIL_ORIGIN}/in"`)));
t("rendered transactional email has no marketing wording", noMarketing(sample(transactional)));
t("rendered marketing email has its consent line", sample(marketing).includes("your preferences"));

t("unknown footer kind throws (no silent missing footer)", throws(() => footer({ kind: "promo" } as unknown as EmailFooter)));
t("unknown footer kind throws in footerText", throws(() => footerText({ kind: "promo" } as unknown as EmailFooter)));
t("unknown footer kind throws in renderEmail", throws(() => renderEmail({ title: "t", preheader: "p", body: [], footer: { kind: "promo" } as unknown as EmailFooter })));
t("missing footer throws in renderEmail", throws(() => renderEmail({ title: "t", preheader: "p", body: [], footer: undefined as unknown as EmailFooter })));
t("marketing footer with empty reason throws", throws(() => footer({ kind: "marketing", reason: "", preferencesHref: "/in" })));
t("marketing footer with whitespace reason throws", throws(() => footer({ kind: "marketing", reason: "   ", preferencesHref: "/in" })));
t("marketing footer without preferences link throws", throws(() => footer({ kind: "marketing", reason: "r" } as unknown as EmailFooter)));
t("marketing footer with foreign unsubscribe link throws", throws(() => footer({ ...marketing, unsubscribeHref: "https://evil.example/u" })));
t("marketing text footer validated the same way", throws(() => footerText({ kind: "marketing", reason: " ", preferencesHref: "/in" })));
t("transactional footer ignores marketing-only fields", noMarketing(String(footer({ kind: "transactional", reason: "x", preferencesHref: "/in" } as unknown as EmailFooter))));

const tt = footerText(transactional);
const mt = footerText({ ...marketing, unsubscribeHref: "/in/u" });
t("text footer transactional: no marketing wording", noMarketing(tt) && tt.includes("reply to this email"));
t("text footer marketing: reason, absolute links, separate line", mt.includes("receiving this because") && mt.includes(`${EMAIL_ORIGIN}/in/account/settings`) && mt.includes(`Unsubscribe: ${EMAIL_ORIGIN}/in/u`) && mt.includes("Order and delivery emails are separate"));
t("text footer security", footerText({ kind: "security" }).startsWith("This is an account security email from THE WOVENNE."));

// ── 6. No tracking, single host ─────────────────────────────────────────────
console.log("6. Tracking");
const urls = [...sample(marketing).matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
t("every href/src is on www.thewovenne.com", urls.length > 0 && urls.every((u) => u.startsWith(`${EMAIL_ORIGIN}/`)), urls.join(" "));
t("no tracking parameters added", urls.every((u) => !/utm_|[?&](mc_|_hs|trk)/i.test(u)));
t("exactly one image request (emblem)", count(sample(marketing), /<img\b/g) === 1);
t("deterministic output", sample() === sample());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

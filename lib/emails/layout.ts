/**
 * The shared shell for every customer email the application sends.
 *
 * Taken from the r4 password-reset email (the one approved and live in
 * Supabase): emblem, wordmark, tagline and terracotta rule on top; a 560px
 * column; Ink buttons; a quiet footer. The Supabase templates cannot import
 * this file. They are pasted into the dashboard, and r4 stays the reference.
 *
 * ESCAPING IS THE DEFAULT, NOT A STEP TO REMEMBER. Every helper takes plain
 * strings and escapes them. The only way to put markup into an email is the
 * `html` tag below, which escapes everything interpolated into it unless it is
 * already SafeHtml, i.e. something this module built. The invoice emails show
 * what happens when escaping is a step: a customer's name went into the HTML
 * raw. Here the easy path is the safe one.
 *
 * LINKS ONLY POINT AT THE SHOP. `safeHref` accepts our own origin, a path on
 * it, or a mailto. Anything else throws while the email is being built. A
 * template that passes a stray URL fails in its tests and previews, never in
 * an inbox. Nothing here reads request headers or env, so a preview deployment
 * cannot leak its hostname into an email either.
 *
 * NO TRACKING. No pixels, no redirects, no query parameters added to links.
 * The one image is the emblem, a static first-party file with no identifier.
 *
 * Construction follows the existing templates: tables with role="presentation",
 * inline styles only (Gmail drops <style> blocks, Outlook ignores flexbox), no
 * web fonts, no scripts, no background images.
 */

/** Where every link and the emblem point. Fixed on purpose; see above. */
export const EMAIL_ORIGIN = "https://www.thewovenne.com";

/**
 * The deployed v1 emblem (PR #215). Never change that file in place: emails
 * already sent load it. A new logo ships as -v2 and this constant moves.
 */
export const EMBLEM_URL = `${EMAIL_ORIGIN}/email/wovenne-emblem-v1.png`;

export const BRAND = {
  name: "THE WOVENNE",
  tagline: "Chosen piece by piece.",
  /** How the team signs off, as in r4. */
  signature: "The Wovenne Team",
} as const;

export const EMAIL_COLORS = {
  ink: "#1C1F3B", // 16.05:1 on white: headings, emphasis, buttons, links
  maroon: "#640E0D", // 13.04:1: emblem alt text
  terracotta: "#C2714F", // 3.64:1, so decorative only: the header rule
  muted: "#6B6B76", // 5.26:1: body copy on white (never on linen at small sizes)
  linen: "#F0EAD6", // info-box background, Ink text only
  rule: "#EEEEEE",
  white: "#FFFFFF",
} as const;

const FONT = "Helvetica,Arial,sans-serif";

// ── Safe HTML ───────────────────────────────────────────────────────────────

export type { SafeHtml };

/**
 * Markup this module produced. Plain strings are never treated as markup.
 *
 * Exported as a TYPE only. If callers could `new SafeHtml(x)`, any of them
 * could mark a customer's name as trusted markup; the only way in is `html`.
 */
class SafeHtml {
  private readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Interpolation =
  | SafeHtml
  | string
  | number
  | null
  | undefined
  | false
  | readonly Interpolation[];

/** Escapes text for HTML content and for double- or single-quoted attributes. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function interpolate(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escapeHtml(value);
}

/**
 * Tagged template for building markup. Interpolated values are escaped unless
 * they are SafeHtml; arrays are joined; null, undefined and false vanish.
 *
 *   html`<strong>${customerName}</strong>`
 */
export function html(
  strings: TemplateStringsArray,
  ...values: Interpolation[]
): SafeHtml {
  let out = strings[0];
  values.forEach((v, i) => {
    out += interpolate(v) + strings[i + 1];
  });
  return new SafeHtml(out);
}

// ── Links ───────────────────────────────────────────────────────────────────

const OWN_HOSTS = new Set(["www.thewovenne.com", "thewovenne.com"]);
/** One plain address at the shop's own domain: hello@, orders@. */
const MAILTO = /^mailto:[a-z0-9._+-]+@thewovenne\.com$/i;

/**
 * A link target that is safe to put in an email, or a thrown error.
 *
 * - "/in/account/orders" → the production origin + that path
 * - "https://www.thewovenne.com/…" or "https://thewovenne.com/…" → as given
 * - "mailto:hello@thewovenne.com" → as given; one address at the shop's own
 *   domain, no ?subject= or extra recipients
 *
 * Refused: other hosts (including couriers, until a reviewed allowlist
 * exists), http:, ports, credentials, protocol-relative "//" and "/\\",
 * javascript:, data:, and whitespace or control characters anywhere.
 * Paths are parsed like absolute URLs, so the result is normalised and
 * percent-encoded (invisible and bidi characters included). Callers must
 * still encodeURIComponent any dynamic path segment such as a slug.
 * The result still has to be escaped for the attribute; the helpers do that.
 */
export function safeHref(target: string): string {
  const t = String(target ?? "");
  if (!t || /[\s\u0000-\u001f\u007f]/.test(t)) {
    throw new TypeError(`Email link refused (empty or contains whitespace): ${JSON.stringify(t)}`);
  }
  if (t.startsWith("mailto:")) {
    if (MAILTO.test(t)) return t;
    throw new TypeError(`Email link refused (malformed mailto): ${JSON.stringify(t)}`);
  }
  const relative = t.startsWith("/");
  if (relative && (t.startsWith("//") || t.startsWith("/\\"))) {
    throw new TypeError(`Email link refused (protocol-relative): ${JSON.stringify(t)}`);
  }
  let url: URL;
  try {
    url = relative ? new URL(t, EMAIL_ORIGIN) : new URL(t);
  } catch {
    throw new TypeError(`Email link refused (not a URL): ${JSON.stringify(t)}`);
  }
  if (url.protocol !== "https:" || !OWN_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new TypeError(`Email link refused (not the shop's own https origin): ${JSON.stringify(t)}`);
  }
  return url.toString();
}

// ── Content sections ────────────────────────────────────────────────────────
// Each returns one <tr> of the content column, so they stack in order.

/**
 * A pixel value for a style attribute. Always a small integer, so nothing a
 * caller passes (even past the type, from plain JS) can reach the markup.
 */
function clampPx(px: unknown): number {
  const n = Math.round(Number(px));
  return Number.isFinite(n) ? Math.max(0, Math.min(80, n)) : 0;
}

const row = (style: string, inner: SafeHtml) =>
  html`<tr><td style="${new SafeHtml(style)}">${inner}</td></tr>`;

/** The email's title line. One per email. */
export function heading(text: string): SafeHtml {
  return row(
    `padding-bottom:8px;font-family:${FONT};`,
    html`<h1 style="margin:0;padding:0;font-family:${new SafeHtml(FONT)};font-size:24px;line-height:1.3;font-weight:normal;color:${new SafeHtml(EMAIL_COLORS.ink)};">${text}</h1>`
  );
}

/** First name for a greeting, or nothing. Never "there". */
export function firstName(name: string | null | undefined): string | null {
  const first = String(name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** "Hello Ananya," or "Hello," when no name is known. */
export function greetingText(name?: string | null): string {
  const first = firstName(name);
  return first ? `Hello ${first},` : "Hello,";
}

export function greeting(name?: string | null): SafeHtml {
  return row(
    `padding-bottom:12px;font-family:${FONT};font-size:15px;line-height:1.6;color:${EMAIL_COLORS.ink};`,
    html`${greetingText(name)}`
  );
}

export type ParagraphTone = "body" | "small";

/**
 * A paragraph. Pass a string (escaped) or `html` markup for emphasis:
 *   paragraph(html`Order ${strong(ref)} is on its way.`)
 */
export function paragraph(
  content: string | SafeHtml,
  opts: { tone?: ParagraphTone; spaceAfter?: number } = {}
): SafeHtml {
  const size = opts.tone === "small" ? 14 : 15;
  const after = clampPx(opts.spaceAfter ?? (opts.tone === "small" ? 16 : 24));
  return row(
    `padding-bottom:${after}px;font-family:${FONT};font-size:${size}px;line-height:1.6;color:${EMAIL_COLORS.muted};`,
    html`${content}`
  );
}

/** Ink emphasis inside a paragraph. */
export function strong(text: string | SafeHtml): SafeHtml {
  return html`<strong style="color:${new SafeHtml(EMAIL_COLORS.ink)};">${text}</strong>`;
}

/** An inline text link: Ink, underlined, never terracotta. */
export function link(href: string, label: string): SafeHtml {
  return html`<a href="${safeHref(href)}" style="color:${new SafeHtml(EMAIL_COLORS.ink)};text-decoration:underline;">${label}</a>`;
}

/**
 * The one primary action. A bulletproof button: the cell carries bgcolor so
 * Outlook paints it, the padded link is the tap target (about 46px tall).
 * Outlook desktop draws square corners and only the text is clickable there.
 */
export function button(opts: { href: string; label: string }): SafeHtml {
  const href = safeHref(opts.href);
  return row(
    "padding-bottom:28px;",
    html`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${new SafeHtml(EMAIL_COLORS.ink)}" style="border-radius:999px;background:${new SafeHtml(EMAIL_COLORS.ink)};mso-padding-alt:14px 28px;"><a href="${href}" style="display:inline-block;padding:14px 28px;font-family:${new SafeHtml(FONT)};font-size:15px;line-height:18px;letter-spacing:1px;color:#ffffff;text-decoration:none;border-radius:999px;">${opts.label}</a></td></tr></table>`
  );
}

/**
 * A linen panel for the facts a customer may look for later: an order
 * reference, an invoice number. Ink text only, since muted grey on linen fails
 * contrast at small sizes.
 */
export function infoBox(content: string | SafeHtml): SafeHtml {
  return row(
    "padding-bottom:24px;",
    html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${new SafeHtml(EMAIL_COLORS.linen)}" style="padding:14px 16px;background:${new SafeHtml(EMAIL_COLORS.linen)};border-radius:8px;font-family:${new SafeHtml(FONT)};font-size:14px;line-height:1.7;color:${new SafeHtml(EMAIL_COLORS.ink)};">${content}</td></tr></table>`
  );
}

/** "Kind regards, / The Wovenne Team", as in r4. */
export function closing(): SafeHtml {
  return row(
    `padding-bottom:32px;font-family:${FONT};font-size:15px;line-height:1.6;color:${EMAIL_COLORS.ink};`,
    html`Kind regards,<br>${BRAND.signature}`
  );
}

// ── Footers ─────────────────────────────────────────────────────────────────

/**
 * Three kinds, deliberately not interchangeable:
 *
 * - transactional: about an order the customer placed. Reply line, site link.
 *   Never any marketing or unsubscribe wording, because these must keep
 *   arriving whatever the marketing preference.
 * - security: the r4 footer, for anything about the account itself.
 * - marketing: must say why it arrived and how to stop it. `reason` and
 *   `preferencesHref` are required by the type; `unsubscribeHref` is for a
 *   one-click link once one exists. Says order emails are separate.
 */
export type EmailFooter =
  | { kind: "transactional"; note?: string }
  | { kind: "security" }
  | {
      kind: "marketing";
      /** Why this person is receiving it, e.g. "You're receiving this because…" */
      reason: string;
      preferencesHref: string;
      unsubscribeHref?: string;
    };

const SITE_LINK_LABEL = "thewovenne.com";
const REPLY_LINE = "Questions? Just reply to this email — it reaches us directly.";
const MARKETING_SEPARATE =
  "Order and delivery emails are separate and will keep arriving.";

function footerRow(inner: SafeHtml): SafeHtml {
  return row(
    `border-top:1px solid ${EMAIL_COLORS.rule};padding-top:20px;font-family:${FONT};font-size:12px;line-height:1.6;color:${EMAIL_COLORS.muted};`,
    inner
  );
}

const brandInk = () =>
  html`<span style="color:${new SafeHtml(EMAIL_COLORS.ink)};">${BRAND.name}</span>`;

/**
 * Refuses a footer that would carry the wrong disclosures: an unknown kind
 * (which would otherwise render no footer at all), or a marketing footer
 * without a reason or a working preferences link.
 */
function checkFooter(f: EmailFooter): void {
  if (f?.kind === "marketing") {
    if (!String(f.reason ?? "").trim()) {
      throw new TypeError("Marketing footer needs a reason: why the person is receiving it.");
    }
    safeHref(f.preferencesHref);
    if (f.unsubscribeHref !== undefined) safeHref(f.unsubscribeHref);
    return;
  }
  if (f?.kind === "transactional" || f?.kind === "security") return;
  throw new TypeError(`Unknown email footer kind: ${JSON.stringify((f as { kind?: unknown })?.kind)}`);
}

export function footer(f: EmailFooter): SafeHtml {
  checkFooter(f);
  const site = link("/in", SITE_LINK_LABEL);
  switch (f.kind) {
    case "transactional":
      return footerRow(
        html`${f.note ? html`${f.note}<br><br>` : ""}${REPLY_LINE}<br><br>${brandInk()}<br>${site}`
      );
    case "security":
      return footerRow(
        html`This is an account security email from ${brandInk()}.<br>${site}`
      );
    case "marketing":
      return footerRow(
        html`${f.reason} You can change this any time in ${link(f.preferencesHref, "your preferences")}${
          f.unsubscribeHref ? html` or ${link(f.unsubscribeHref, "unsubscribe")}` : ""
        }. ${MARKETING_SEPARATE}<br><br>${brandInk()}<br>${site}`
      );
  }
}

/** The same footer as plain text, for the text part every email carries. */
export function footerText(f: EmailFooter): string {
  checkFooter(f);
  const site = `${EMAIL_ORIGIN}/in`;
  switch (f.kind) {
    case "transactional":
      return [...(f.note ? [f.note, ""] : []), REPLY_LINE, "", BRAND.name, site].join("\n");
    case "security":
      return [`This is an account security email from ${BRAND.name}.`, site].join("\n");
    case "marketing":
      return [
        f.reason,
        `Change your preferences: ${safeHref(f.preferencesHref)}`,
        ...(f.unsubscribeHref ? [`Unsubscribe: ${safeHref(f.unsubscribeHref)}`] : []),
        MARKETING_SEPARATE,
        "",
        BRAND.name,
        site,
      ].join("\n");
  }
}

/** "Kind regards,\nThe Wovenne Team" for text parts. */
export const CLOSING_TEXT = `Kind regards,\n${BRAND.signature}`;

// ── The document ────────────────────────────────────────────────────────────

/**
 * The r4 header. With images blocked, the alt text shows in maroon inside the
 * reserved 90×81 box, and the text wordmark below still names the shop, so
 * the brand never depends on the image.
 */
function header(): SafeHtml {
  return new SafeHtml(
    `<tr>
            <td align="center" style="padding-bottom:20px;border-bottom:2px solid ${EMAIL_COLORS.terracotta};font-family:${FONT};text-align:center;">
              <img src="${EMBLEM_URL}" width="90" height="81" alt="${BRAND.name} emblem" style="display:block;margin:0 auto 14px;width:90px;max-width:90px;height:auto;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:12px;line-height:1.4;color:${EMAIL_COLORS.maroon};">
              <div style="font-size:22px;letter-spacing:2px;color:${EMAIL_COLORS.ink};">${BRAND.name}</div>
              <div style="font-size:12px;color:${EMAIL_COLORS.muted};margin-top:4px;">${BRAND.tagline}</div>
            </td>
          </tr>
          <tr><td style="height:28px;line-height:28px;font-size:0;">&nbsp;</td></tr>`
  );
}

export interface EmailDocument {
  /** The document <title>; usually the subject. */
  title: string;
  /**
   * The inbox preview line, hidden in the body. One sentence about what the
   * email is for. Required: without it clients preview the header text.
   */
  preheader: string;
  /** Sections from the helpers above, in order. */
  body: readonly SafeHtml[];
  footer: EmailFooter;
}

/** The complete HTML document, ready for sendEmail({ html }). */
export function renderEmail(doc: EmailDocument): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(doc.title)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">${escapeHtml(doc.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          ${header()}
          ${doc.body.map((s) => interpolate(s)).join("\n          ")}
          ${footer(doc.footer)}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

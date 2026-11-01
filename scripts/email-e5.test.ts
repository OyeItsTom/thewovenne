/**
 * WP-EMAIL-E5: the cancellation and style-photo rejection emails on the E1
 * layout, and the same-origin check on the three admin routes behind them.
 *
 * Proves:
 *   1. escaping: names, reasons, items, references can never become markup;
 *   2. truthful content: no refund made / started / timed, no "never sent",
 *      the attachment mentioned only when attached, the order unaffected by a
 *      photo decision, no reply-to promise;
 *   3. the customer-visible reason is capped at 500 characters while the
 *      route still records the full text;
 *   4. HTML and plain text carry the same facts and sentences;
 *   5. links only to the production origin, the resubmission button included;
 *   6. same-origin: permitted and refused requests, and the order of checks in
 *      the cancel, reject and moderate routes;
 *   7. business rules untouched: same RPC calls, same stamp, no edits to SQL,
 *      the credit-note PDF, or the admin screens; the PDF still renders.
 *
 *   npx tsx scripts/email-e5.test.ts
 *
 * Sends nothing and touches no database. Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import CreditNoteDocument from "../components/invoice/CreditNoteDocument";
import { buildCreditNote } from "../lib/creditNote";
import { inr } from "../lib/invoice";
import { isSameOrigin } from "../lib/sameOrigin";
import { EMAIL_COLORS, EMAIL_ORIGIN, EMBLEM_URL, escapeHtml, footerText } from "../lib/emails/layout";
import { customerVisibleText, greetingName } from "../lib/emails/greetingName";
import {
  CANCELLATION_REASON_MAX,
  orderCancelledHtml,
  orderCancelledSubject,
  orderCancelledText,
  type CancelledEmailData,
} from "../lib/emails/orderCancelled";
import {
  STYLE_RESUBMIT_PATH,
  styleRejectedHtml,
  styleRejectedSubject,
  styleRejectedText,
  type StyleRejectedData,
} from "../lib/emails/styleRejected";

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
const root = path.join(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const visible = (h: string) =>
  h
    .replace(/<div style="display:none[\s\S]*?<\/div>/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<br>/g, "\n")
    .replace(/<\/?strong[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
/** Every non-empty body line of the text part (above the footer) appears in the HTML. */
const parity = (h: string, x: string) => {
  const vis = visible(h);
  return x
    .split("\n--\n")[0]
    .split("\n")
    .map((l) => l.trim().replace(/^- /, ""))
    .filter(Boolean)
    .filter((l) => !l.startsWith("Send another photograph: "))
    .filter((l) => !vis.includes(l.replace(/\s+/g, " ")));
};

const ATTACKS = [
  `<a href="https://evil.example/login">Verify</a>`,
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `"><svg/onload=alert(1)>`,
  `&lt;b&gt;pre-escaped & "quoted" 'single'`,
];
// Escaped text may legitimately SAY "evil.example"; what must never appear is
// live markup or a link to it.
const injected = (h: string) => /<script|<img src=x|<svg|<a href="https?:\/\/(?!www\.thewovenne\.com)/i.test(h);

// ── Cancellation ───────────────────────────────────────────────────────────

const cancelled = (o: Partial<CancelledEmailData> = {}): CancelledEmailData => ({
  orderRef: "A53C16F7",
  customerName: "Ananya Menon",
  items: [
    { name: "Kerala Kasavu Saree", size: "Free", quantity: 1 },
    { name: "Handwoven Linen Kurta", size: "One Size", quantity: 2 },
  ],
  amount: 8900,
  creditNoteNumber: "CN-2026-0002",
  invoiceNumber: "WOV-2026-0043",
  reason: "The weaver could not finish the piece in time.",
  creditNoteAttached: true,
  ...o,
});

{
  t("cancel: subject unchanged", orderCancelledSubject("A53C16F7") === "Your THE WOVENNE order A53C16F7 has been cancelled");
  t("cancel: subject strips newlines", !/[\r\n]/.test(orderCancelledSubject("A53\r\nBcc: x@y")));

  for (const a of ATTACKS) {
    const d = cancelled({ customerName: a, reason: a, items: [{ name: a, size: a, quantity: 1 }], orderRef: `R${a}`, creditNoteNumber: `CN${a}`, invoiceNumber: `W${a}` });
    const h = orderCancelledHtml(d);
    t(`cancel: no injected markup — ${a}`, !injected(h));
    t(`cancel: reason escaped — ${a}`, h.includes(escapeHtml(customerVisibleText(a)!)));
    t(`cancel: title escaped — ${a}`, !/<title>[^<]*<(?!\/title)/.test(h));
  }
  const nameless = orderCancelledHtml(cancelled({ customerName: "<b>Ananya</b>" }));
  t("cancel: name with markup greets as Hello,", nameless.includes(">Hello,<") && !nameless.includes("<b>Ananya"));
  for (const n of [null, "", "  ", "​", "‮"]) {
    t(`cancel: empty name ${JSON.stringify(n)} → Hello,`, orderCancelledText(cancelled({ customerName: n })).includes("\nHello,\n"));
  }
  t("cancel: first name only", orderCancelledText(cancelled()).includes("Hello Ananya,") && !orderCancelledText(cancelled()).includes("Menon"));
  t("cancel: Malayalam name", orderCancelledText(cancelled({ customerName: "അനന്യ മേനോൻ" })).includes("Hello അനന്യ,"));
  t("cancel: never 'there'", !/\bthere\b/i.test(orderCancelledText(cancelled({ customerName: null }))));

  // Truthful content.
  for (const [label, d] of [
    ["online", cancelled()],
    ["no reason", cancelled({ reason: null })],
    ["no attachment", cancelled({ creditNoteAttached: false })],
    ["no invoice", cancelled({ invoiceNumber: null })],
  ] as const) {
    const h = orderCancelledHtml(d);
    const x = orderCancelledText(d);
    const all = x + " " + visible(h);
    t(`cancel ${label}: no refund made/started/timed`, !/refunded|refund (is|has been) (made|issued|processed|sent|initiated|on its way)|on its way|working days|5 to 7|within \d|back to (the way|your)|original payment|way you paid|reaches you/i.test(all));
    t(`cancel ${label}: says a credit note is not a paid refund`, /it is not confirmation that a refund has been paid/.test(x) && /it is not confirmation that a refund has been paid/.test(visible(h)));
    t(`cancel ${label}: no promise the parcel was never sent`, !/nothing will be sent|will not be sent|never (shipped|sent|dispatched)|not been shipped/i.test(all));
    t(`cancel ${label}: no reply-to promise`, !/reply to this email|just reply|reaches us directly|reply\b/i.test(all));
    t(`cancel ${label}: heading`, h.includes(">Your order has been cancelled</h1>") && x.startsWith("Your order has been cancelled\n"));
    t(`cancel ${label}: credit note number`, x.includes("Credit note: CN-2026-0002") && h.includes("CN-2026-0002"));
    t(`cancel ${label}: amount as the PDF prints it`, x.includes(`Amount credited: ${inr(8900)}`) && h.includes(inr(8900)));
    t(`cancel ${label}: order ref`, x.includes("Order: A53C16F7"));
    t(`cancel ${label}: transactional footer`, x.endsWith(footerText({ kind: "transactional" })) && h.includes("Need help? Our contact details are on our website."));
    t(`cancel ${label}: no marketing wording`, !/unsubscribe|preferences/i.test(all));
    const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    t(`cancel ${label}: links only to the shop`, hrefs.every((u) => u.startsWith(`${EMAIL_ORIGIN}/`)), hrefs.join(" "));
    t(`cancel ${label}: no button`, !h.includes("border-radius:999px"));
    t(`cancel ${label}: E1 header`, h.includes(`src="${EMBLEM_URL}"`) && h.includes(">THE WOVENNE</div>") && h.startsWith("<!doctype html>"));
    t(`cancel ${label}: text has no markup`, !/<[a-z/!]/i.test(x));
    const miss = parity(h, x);
    t(`cancel ${label}: text/HTML parity`, miss.length === 0, miss.join(" | "));
  }
  {
    const d = cancelled({ creditNoteAttached: true });
    t("cancel attached: sentence in HTML + text", orderCancelledText(d).includes("The credit note is attached to this email as a PDF.") && visible(orderCancelledHtml(d)).includes("The credit note is attached to this email as a PDF."));
    t("cancel attached: preheader says attached", orderCancelledHtml(d).includes("Credit note CN-2026-0002 is attached."));
    const n = cancelled({ creditNoteAttached: false });
    const all = orderCancelledText(n) + orderCancelledHtml(n);
    t("cancel not attached: never says attached", !/attached/i.test(all));
    t("cancel not attached: preheader says issued", orderCancelledHtml(n).includes("Credit note CN-2026-0002 has been issued."));
  }
  {
    const x = orderCancelledText(cancelled());
    t("cancel: credit note against invoice", x.includes("We have issued credit note CN-2026-0002 against invoice WOV-2026-0043."));
    t("cancel: invoice fact", x.includes("Invoice: WOV-2026-0043"));
    const ni = orderCancelledText(cancelled({ invoiceNumber: null }));
    t("cancel no invoice: no invoice line or 'against'", !ni.includes("Invoice:") && !ni.includes("against invoice"));
    t("cancel: paise amount rounds as the PDF", orderCancelledText(cancelled({ amount: 8900.4 })).includes("Amount credited: INR 8,900"));
  }
  {
    // Reasons.
    const x = orderCancelledText(cancelled());
    t("cancel: reason shown", x.includes("Reason: The weaver could not finish the piece in time."));
    t("cancel: no reason → no Reason line", !orderCancelledText(cancelled({ reason: null })).includes("Reason:") && !orderCancelledText(cancelled({ reason: "   " })).includes("Reason:"));
    const long = "a".repeat(450) + " " + "b".repeat(200);
    const lx = orderCancelledText(cancelled({ reason: long }));
    const shown = lx.split("\n").find((l) => l.startsWith("Reason: "))!.slice("Reason: ".length);
    t("cancel: long reason capped at 500 characters", Array.from(shown).length <= CANCELLATION_REASON_MAX && shown.endsWith("…"), String(Array.from(shown).length));
    t("cancel: long reason never shown whole", !lx.includes(long) && !orderCancelledHtml(cancelled({ reason: long })).includes(long));
    t("cancel: exactly 500 chars kept whole", orderCancelledText(cancelled({ reason: "c".repeat(500) })).includes("c".repeat(500)));
    t("cancel: multi-line reason flattened", orderCancelledText(cancelled({ reason: "Line one\n\nLine two\r\nthree" })).includes("Reason: Line one Line two three"));
    t("cancel: bidi in reason removed", !orderCancelledText(cancelled({ reason: "‮evil" })).includes("‮"));
    t("cancel: emoji reason kept", orderCancelledText(cancelled({ reason: "Out of stock 🧵" })).includes("Out of stock 🧵"));
    t("cancel: 500-char cap counts characters not bytes", Array.from(customerVisibleText("അ".repeat(800))!).length === 500);
  }
  {
    // Items.
    const x = orderCancelledText(cancelled());
    t("cancel: items listed", x.includes("- Kerala Kasavu Saree · Free × 1") && x.includes("- Handwoven Linen Kurta × 2"));
    t("cancel: no items → no heading", !orderCancelledText(cancelled({ items: [] })).includes("What was cancelled"));
    t("cancel: odd items tolerated", !throws(() => orderCancelledHtml(cancelled({ items: [null as never, { name: "", quantity: 0 }] as never }))));
  }
  t("cancel: no credit note number refused", throws(() => orderCancelledHtml(cancelled({ creditNoteNumber: " " }))));
  t("cancel: no order ref refused", throws(() => orderCancelledHtml(cancelled({ orderRef: "" }))));
  t("cancel: NaN amount refused", throws(() => orderCancelledHtml(cancelled({ amount: Number.NaN }))));
  t("cancel: negative amount refused", throws(() => orderCancelledHtml(cancelled({ amount: -1 }))));
}

// ── Style rejection ────────────────────────────────────────────────────────

const rejected = (o: Partial<StyleRejectedData> = {}): StyleRejectedData => ({
  customerName: "Ananya Menon",
  productName: "Mul Cotton Saree",
  reason: "The photograph is a little blurry — a sharper one would show the weave better.",
  ...o,
});
{
  t("style: subject unchanged", styleRejectedSubject("Mul Cotton Saree") === "About the photograph you sent us — Mul Cotton Saree");
  t("style: subject without product", styleRejectedSubject(null) === "About the photograph you sent us — your piece");
  t("style: subject no verdict", !/reject|declin|unsuccessful|sorry/i.test(styleRejectedSubject("X")));
  t("style: subject strips newlines", !/[\r\n]/.test(styleRejectedSubject("Saree\r\nBcc: x")));

  for (const a of ATTACKS) {
    const h = styleRejectedHtml(rejected({ customerName: a, productName: a, reason: a }));
    t(`style: no injected markup — ${a}`, !injected(h));
    t(`style: reason escaped — ${a}`, h.includes(escapeHtml(customerVisibleText(a)!)));
  }
  const h = styleRejectedHtml(rejected());
  const x = styleRejectedText(rejected());
  const all = x + " " + visible(h);
  t("style: heading", h.includes(">Thank you for your photograph</h1>"));
  t("style: thanks before the reason", visible(h).indexOf("grateful") < visible(h).indexOf("not able to use"));
  t("style: reason shown", x.includes("The photograph is a little blurry") && h.includes("The photograph is a little blurry"));
  t("style: product named", x.includes("photograph of your Mul Cotton Saree"));
  t("style: order unaffected", x.includes("Nothing about your order is affected by this.") && visible(h).includes("Nothing about your order is affected by this."));
  t("style: no reply-to promise", !/reply|reaches us directly/i.test(all));
  t("style: no approval/publication/deletion claims", !/approved|published|on the site|deleted|removed/i.test(all));
  const button = h.match(/<a href="([^"]+)"[^>]*>Send another photograph<\/a>/);
  t("style: button to the production orders page", button?.[1] === `${EMAIL_ORIGIN}${STYLE_RESUBMIT_PATH}`, button?.[1]);
  t("style: resubmit path is the orders page", STYLE_RESUBMIT_PATH === "/in/account/orders");
  t("style: button is Ink, not terracotta", h.includes(`bgcolor="${EMAIL_COLORS.ink}"`) && !/background:#C2714F[^;]*;[^>]*>Send another/.test(h));
  t("style: text carries the same URL", x.includes(`Send another photograph: ${EMAIL_ORIGIN}/in/account/orders`));
  const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  t("style: links only to the shop", hrefs.every((u) => u.startsWith(`${EMAIL_ORIGIN}/`)), hrefs.join(" "));
  t("style: E1 header", h.includes(`src="${EMBLEM_URL}"`) && h.startsWith("<!doctype html>"));
  t("style: transactional footer", x.endsWith(footerText({ kind: "transactional" })));
  t("style: text has no markup", !/<[a-z/!]/i.test(x));
  const miss = parity(h, x);
  t("style: text/HTML parity", miss.length === 0, miss.join(" | "));
  t("style: no product → 'your piece'", styleRejectedText(rejected({ productName: null })).includes("photograph of your piece"));
  t("style: markup name → Hello,", styleRejectedHtml(rejected({ customerName: "<i>x</i>" })).includes(">Hello,<"));
  t("style: empty name → Hello,", styleRejectedText(rejected({ customerName: null })).includes("\nHello,\n"));
  t("style: empty reason refused", throws(() => styleRejectedHtml(rejected({ reason: "  " }))));
  const long = "z".repeat(700);
  t("style: long reason capped", !styleRejectedText(rejected({ reason: long })).includes(long) && styleRejectedText(rejected({ reason: long })).includes("z".repeat(499) + "…"));
  t("style: template reads no environment", !/process\.env/.test(code(read("lib/emails/styleRejected.ts"))));
  t("cancel: template reads no environment", !/process\.env/.test(code(read("lib/emails/orderCancelled.ts"))));
}

// ── greetingName / customerVisibleText ─────────────────────────────────────
t("greetingName: zero-width removed", greetingName("An​anya") === "Ananya");
t("greetingName: long capped", greetingName("A".repeat(999))!.length === 40);
t("greetingName: markup → null", greetingName("<b>x") === null);
t("customerVisibleText: blank → null", customerVisibleText(" \n\t ") === null);

// ── Same-origin ────────────────────────────────────────────────────────────
{
  const req = (url: string, origin?: string) => new NextRequest(url, { method: "POST", headers: origin === undefined ? {} : { origin } });
  for (const p of ["/api/admin/orders/cancel", "/api/admin/style/reject", "/api/admin/style/moderate"]) {
    const url = `https://www.thewovenne.com${p}`;
    t(`${p}: same origin permitted`, isSameOrigin(req(url, "https://www.thewovenne.com")));
    for (const [why, o] of [
      ["cross-site", "https://evil.example"],
      ["look-alike", "https://www.thewovenne.com.evil.example"],
      ["apex vs www", "https://thewovenne.com"],
      ["null", "null"],
      ["empty", ""],
      ["malformed", "not a url"],
      ["other port", "https://www.thewovenne.com:8443"],
    ] as const) {
      t(`${p}: ${why} refused`, !isSameOrigin(req(url, o)));
    }
    t(`${p}: absent Origin refused`, !isSameOrigin(req(url)));
  }

  const routes: [string, string, string[]][] = [
    ["cancel", "app/api/admin/orders/cancel/route.ts", ["request.json()", 'rpc("cancel_order"', '.from("orders")', "sendEmail("]],
    ["reject", "app/api/admin/style/reject/route.ts", ["request.json()", "createServiceClient()", "removeGalleryCopies(", 'rpc("moderate_style"', 'rpc("claim_style_rejection_notice"', "sendClaimedRejection(", 'rpc("record_style_rejection_notice"']],
    ["moderate", "app/api/admin/style/moderate/route.ts", ["request.json()", "createServiceClient()", 'rpc("approve_style"', 'rpc("moderate_style"', "removeGalleryCopies("]],
  ];
  for (const [name, file, after] of routes) {
    const src = code(read(file));
    const gate = src.indexOf("await adminApiGate(request)");
    const origin = src.indexOf('if (!isSameOrigin(request)) return NextResponse.json({ ok: false, error: "Not allowed." }, { status: 403 })');
    const admin = src.indexOf('rpc("is_admin")');
    t(`${name}: shared helper imported`, src.includes('import { isSameOrigin } from "@/lib/sameOrigin"'));
    t(`${name}: same-origin 403 present`, origin > 0);
    t(`${name}: gate → same-origin → is_admin`, gate > 0 && gate < origin && origin < admin);
    t(`${name}: exactly one same-origin check`, (src.match(/isSameOrigin\(request\)/g) ?? []).length === 1);
    for (const f of after) {
      const at = src.indexOf(f);
      t(`${name}: ${f} after same-origin and is_admin`, at > admin, String(at));
    }
  }
}

// ── Business rules untouched ───────────────────────────────────────────────
{
  const cancel = code(read("app/api/admin/orders/cancel/route.ts"));
  t("cancel route: same RPC with the full reason", /rpc\("cancel_order", \{\s*p_order_id: orderId,\s*p_reason: trimmedReason,\s*\}\)/.test(cancel));
  t("cancel route: email gets the same reason (capped only in the template)", /reason: trimmedReason,/.test(cancel));
  t("cancel route: attachment flag from the real PDF", cancel.includes("creditNoteAttached: pdf !== null"));
  t("cancel route: PDF render failure does not stop the email", /try \{\s*pdf = await renderToBuffer\(CreditNoteDocument/.test(cancel));
  t("cancel route: no refund wording source left", !cancel.includes("isOffline") && !cancel.includes("paidInPerson"));
  t("cancel route: email failure still returns ok", /return NextResponse\.json\(\{\s*ok: true,/.test(cancel));
  const reject = code(read("app/api/admin/style/reject/route.ts"));
  t("reject route: same moderation call", /rpc\("moderate_style", \{\s*p_id: id,\s*p_status: "rejected",\s*p_reason: trimmed,\s*\}\)/.test(reject));
  // Stage B (0076): the stamp is written only by record_style_rejection_notice
  // after provider acceptance; the route never writes it directly.
  t("reject route: stamp only via the record function after a claim", !/\.update\(\{\s*rejection_emailed_at/.test(reject)
    && reject.indexOf('rpc("claim_style_rejection_notice"') < reject.indexOf('rpc("record_style_rejection_notice"'));
  t("reject route: no env-built link", !reject.includes("NEXT_PUBLIC_SITE_URL") && !reject.includes("ordersUrl"));
  t("reject route: email failure still returns ok", reject.includes("return NextResponse.json({ ok: true, emailed, problem, notice: report.status, message: report.message })"));
  try {
    execFileSync(
      "git",
      // Only files no other email PR owns. lib/email.ts (#220, #221),
      // lib/emails/layout.ts and OrdersManager.tsx (#221) legitimately change
      // when the PRs are combined, so they are not listed here; that E5 does
      // not touch them is a property of this PR's file list, checked at review.
      ["diff", "--quiet", "main", "--", "lib/creditNote.ts", "components/invoice", "lib/invoice.ts",
        "lib/sameOrigin.ts", "lib/stylePhotoStorage.ts", "app/api/style"],
      { cwd: root }
    );
    t("credit notes, PDFs, invoices, same-origin helper, style storage and style routes unchanged from main", true);
  } catch {
    t("credit notes, PDFs, invoices, same-origin helper, style storage and style routes unchanged from main", false);
  }
  // Existing migrations are never edited; Stage B adds exactly one new file.
  const migDiff = execFileSync("git", ["diff", "--name-status", "main", "--", "supabase/migrations"], { cwd: root, encoding: "utf8" }).trim();
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "supabase/migrations"], { cwd: root, encoding: "utf8" }).trim();
  // Added files are fine (0076 here; 0074/0075 if this runs on top of #220/#221);
  // an EDITED, deleted or renamed existing migration is not.
  const touched = migDiff.split("\n").filter((l) => l && !/^A\t/.test(l));
  t("no existing migration modified, deleted or renamed", touched.length === 0, touched.join(" | "));
  const added = [...migDiff.split("\n").filter((l) => /^A\t/.test(l)).map((l) => l.slice(2)), ...untracked.split("\n").filter(Boolean)];
  t("0076 is present as an added migration", added.includes("supabase/migrations/0076_style_rejection_notices.sql") || fs.existsSync(path.join(root, "supabase/migrations/0076_style_rejection_notices.sql")), added.join(" "));
  const sm = execFileSync("git", ["diff", "main", "--", "components/admin/StyleManager.tsx"], { cwd: root, encoding: "utf8" });
  // Stage B: the screen shows the route's message and the notice status label.
  // It must not gain any new request, route or action.
  const changed = (sm.match(/^[-+][^-+].*$/gm) ?? []).join("\n");
  t("StyleManager: only wording/labels changed (no new requests or actions)",
    sm === "" || (/data\.message \?\?/.test(sm) && /rejectionEmailLabel/.test(sm) && !/fetch\(|\/api\/|onClick|\.rpc\(|\.from\(/.test(changed)), changed.slice(0, 200));
}

(async () => {
  const data = buildCreditNote(
    {
      id: "n1",
      credit_note_number: "CN-2026-0002",
      order_id: "a53c16f7-b5d3-48e5-b825-ed84aa335d59",
      invoice_number: "WOV-2026-0043",
      kind: "cancellation",
      amount_inr: 8900,
      reason: "x".repeat(800),
      items: [{ name: "Kerala Kasavu Saree", size: "Free", quantity: 1, price_inr: 8900 }],
      issued_at: "2026-11-01T06:30:00Z",
    },
    null
  )!;
  t("credit note keeps the full reason (record not shortened)", data.reason === "x".repeat(800));
  const pdf = Buffer.from(await renderToBuffer(CreditNoteDocument({ data })));
  t("credit-note PDF still renders", pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 1500, String(pdf.length));
  console.log(`\nemail-e5: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

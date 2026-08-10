/**
 * The "a photograph is waiting" notice, rendered and checked.
 *
 *   npx tsx scripts/style-notice-preview.ts [outfile]
 *
 * Same reason the rejection email has one: the only way to judge whether an
 * internal notice is scannable in three seconds is to read it. The assertions
 * below cover what is not a matter of taste — that it never carries the
 * photograph or the customer's address, that the subject names the piece, and
 * that a customer's own words are escaped before they reach the markup.
 */
import fs from "node:fs";
import {
  describeWhatArrived,
  styleSubmittedHtml,
  styleSubmittedSubject,
  styleSubmittedText,
  type StyleSubmittedData,
} from "../lib/emails/styleSubmitted";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const base: StyleSubmittedData = {
  productName: "Mul Cotton Saree",
  creditName: "Ananya",
  caption: "Wearing it through the Kochi monsoon — it only gets softer.",
  hasPhoto: true,
  videoPlatform: null,
  queueUrl: "https://www.thewovenne.com/admin/dashboard/style",
};

const html = styleSubmittedHtml(base);
const text = styleSubmittedText(base);

console.log(`\nsubject : ${styleSubmittedSubject(base.productName)}\n`);
console.log(text);

console.log("\n=== what is not a matter of taste ===");

t("the subject names the piece, so two notices are two things",
  styleSubmittedSubject("Cotton Shirt").includes("Cotton Shirt"));

t("the queue link is in both parts",
  html.includes(base.queueUrl) && text.includes(base.queueUrl));

// The photograph is unreviewed content from outside the business. The decision
// is that somebody looks at it in the queue, signed in, not in a mail client.
t("no image is embedded, at all",
  !/<img/i.test(html) && !/photo_url|supabase\.co/i.test(html),
  "an unmoderated photograph must not auto-load in an inbox");

t("the customer's email address is nowhere in it",
  !html.includes("@") || !/[\w.]+@[\w.]+\.\w+/.test(html.replace(base.queueUrl, "")),
  "it is in the queue behind is_admin(); three inboxes do not need a copy");

t("it says nothing is public yet",
  /not public|only once you approve/i.test(text) && /Nothing is public yet/i.test(html),
  "the reason a delayed notice is not an emergency");

t("credit is reported as asked for", html.includes("Ananya") && text.includes("Ananya"));
t("and anonymity is reported too, rather than left blank",
  styleSubmittedText({ ...base, creditName: null }).includes("without a name"));

// ── What arrived ──
t("photograph only", describeWhatArrived({ hasPhoto: true, videoPlatform: null }) === "a photograph");
t("youtube only",
  describeWhatArrived({ hasPhoto: false, videoPlatform: "youtube" }) === "a YouTube link");
t("instagram only",
  describeWhatArrived({ hasPhoto: false, videoPlatform: "instagram" }) === "an Instagram link");
t("both", describeWhatArrived({ hasPhoto: true, videoPlatform: "instagram" })
  === "a photograph and an Instagram link");
t("an unknown platform does not invent a name",
  describeWhatArrived({ hasPhoto: true, videoPlatform: "vimeo" }) === "a photograph");

// ── A caption is a stranger's text ──
const nasty = styleSubmittedHtml({
  ...base,
  caption: '<script>alert("x")</script> & "quotes"',
  creditName: "<b>Ananya</b>",
  productName: "<i>Saree</i>",
});
t("a caption's angle brackets are escaped, not rendered",
  !nasty.includes("<script>") && nasty.includes("&lt;script&gt;"),
  "the caption is written by somebody outside the business");
t("so is the credit name", !nasty.includes("<b>Ananya</b>"));
t("and the product name", !nasty.includes("<i>Saree</i>"));

t("no caption means no empty quote block",
  !styleSubmittedHtml({ ...base, caption: null }).includes("blockquote"));
t("a whitespace-only caption counts as none",
  !styleSubmittedHtml({ ...base, caption: "   " }).includes("blockquote"));

const out = process.argv[2] ?? "style-notice-preview.html";
fs.writeFileSync(out, html);
console.log(`\nwrote ${out} — open it to read the tone\n`);

console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

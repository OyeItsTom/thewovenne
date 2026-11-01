/**
 * The rejection email, rendered to a file and checked.
 *
 *   npx tsx scripts/style-email-preview.ts [outfile]
 *
 * Same reason the invoice has a preview script: this is a message to a real
 * person about a photograph of themselves, and the only way to judge whether it
 * lands as encouraging rather than curt is to read it. It writes the HTML out so
 * it can be opened in a browser, and asserts the two things that are not a matter
 * of taste — that an admin's words are escaped before they reach the markup, and
 * that the subject line does not deliver the verdict in an inbox list.
 */
import fs from "node:fs";
import path from "node:path";
import {
  styleRejectedHtml,
  styleRejectedSubject,
  styleRejectedText,
} from "../lib/emails/styleRejected";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const data = {
  customerName: "Ananya",
  productName: "Mul Cotton Saree",
  reason: "The photograph is a little blurry — a sharper one would show the weave better.",
};

const html = styleRejectedHtml(data);
const text = styleRejectedText(data);
const subject = styleRejectedSubject(data.productName);

console.log(`\nsubject : ${subject}\n`);
console.log(text);

console.log("\n=== what is not a matter of taste ===");
t("the subject does not deliver the verdict in an inbox list",
  !/reject|declin|unsuccessful|sorry/i.test(subject), subject);
t("it opens with thanks rather than the decision",
  html.indexOf("Thank you") < html.indexOf("not able to use"));
t("the reason is actually in there", html.includes("a sharper one would show the weave"));
t("it invites another", /send another/i.test(html) && /send another/i.test(text));
t("and says the order is unaffected",
  /nothing about your order is affected/i.test(text),
  "the reassurance that stops a rejection reading as a problem with the purchase");

// An admin writes the reason by hand, so it is untrusted input as far as the
// markup is concerned — a stray angle bracket must not become a tag.
const nasty = styleRejectedHtml({
  ...data,
  reason: '<script>alert("x")</script> & "quotes"',
  customerName: "<b>Ananya</b>",
});
t("an admin's angle brackets are escaped, not rendered",
  !nasty.includes("<script>") && nasty.includes("&lt;script&gt;"));
t("and a name carrying markup is never rendered — it greets as \"Hello,\"",
  !nasty.includes("<b>Ananya</b>") && nasty.includes(">Hello,<"));

// Never into the repository (WP-EMAIL-E5): a preview left in the tree is one
// `git add .` from being committed.
const out = path.resolve(process.argv[2] ?? path.join(require("node:os").tmpdir(), "style-rejected-preview.html"));
const repo = path.resolve(__dirname, "..");
if (out.startsWith(repo + path.sep)) {
  console.error(`Refusing to write a preview inside the repository: ${out}`);
  process.exit(2);
}
fs.writeFileSync(out, html);
console.log(`\nwrote ${out} — open it to read the tone\n`);

console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Renders sample emails built on lib/emails/layout.ts, for reading in a browser.
 *
 *   npx tsx scripts/email-layout-preview.ts <out-dir>
 *
 * Writes transactional.html, marketing.html and security.html (sample content
 * only, nothing real) into <out-dir>, which must be outside the repository.
 * Reads no env or secrets and makes no network calls. A browser render is not a mail-client
 * render; these are for judging layout and copy, not for client testing.
 * Sends nothing.
 */
import fs from "node:fs";
import path from "node:path";
import {
  button,
  closing,
  greeting,
  heading,
  html,
  infoBox,
  paragraph,
  renderEmail,
  strong,
} from "../lib/emails/layout";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npx tsx scripts/email-layout-preview.ts <out-dir outside the repo>");
  process.exit(2);
}
// Never inside the repository: a sample written into public/ would be served
// from the live site, and one written anywhere else would sit next to code.
const repoPath = path.resolve(__dirname, "..");
const repo = fs.realpathSync(repoPath);
const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
const refuse = (p: string) => {
  console.error(`Refusing to write previews inside the repository (${p}). Use a scratch directory.`);
  process.exit(2);
};
const out = path.resolve(arg);
// Checked before mkdir so not even an empty folder is created in the repo:
// the nearest existing ancestor is resolved through symlinks, so a link that
// points back into the repository is caught too.
let existing = out;
while (!fs.existsSync(existing)) existing = path.dirname(existing);
const realExisting = fs.realpathSync(existing);
const realOut = path.join(realExisting, path.relative(existing, out));
if (inside(out, repoPath) || inside(realOut, repo)) refuse(realOut);
fs.mkdirSync(out, { recursive: true });

const files: Record<string, string> = {
  "transactional.html": renderEmail({
    title: "Sample transactional email",
    preheader: "A sample built on the shared layout. Not a real order.",
    body: [
      heading("A sample transactional email"),
      greeting("Ananya Rao"),
      paragraph(html`This shows the shared layout with an ${strong("information box")}, one button and the transactional footer.`),
      infoBox(html`Sample reference ${strong("SAMPLE01")}`),
      button({ href: "/in", label: "Visit THE WOVENNE" }),
      paragraph("Secondary detail in the smaller size.", { tone: "small" }),
      closing(),
    ],
    footer: { kind: "transactional" },
  }),
  "marketing.html": renderEmail({
    title: "Sample marketing email",
    preheader: "A sample marketing layout with its consent footer.",
    body: [
      heading("A sample marketing email"),
      greeting(null),
      paragraph("Marketing emails use the same shell, with a footer that says why they arrived and how to stop them."),
      button({ href: "/in/shop", label: "Browse the collection" }),
      closing(),
    ],
    footer: {
      kind: "marketing",
      reason: "You're receiving this because you asked for updates when you created your account.",
      preferencesHref: "/in/account/settings",
    },
  }),
  "security.html": renderEmail({
    title: "Sample account email",
    preheader: "A sample account-security layout.",
    body: [
      heading("A sample account email"),
      greeting(null),
      paragraph("Account emails carry no marketing wording and no tracking."),
      closing(),
    ],
    footer: { kind: "security" },
  }),
};

for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), content);
  console.log(`wrote ${path.join(out, name)} (${Buffer.byteLength(content)} bytes)`);
}

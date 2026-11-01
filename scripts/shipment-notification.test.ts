/**
 * WP-EMAIL-E3b — India Post Speed Post: the consignment check, the one
 * approved external link, and the shipping email.
 *
 *   npx tsx scripts/shipment-notification.test.ts
 *
 * Pure: no database, no network, nothing sent.
 */
import {
  CONSIGNMENT_MAX_LENGTH,
  INDIA_POST_LABEL,
  INDIA_POST_TRACKING_URL,
  checkConsignment,
  s10CheckDigit,
} from "../lib/couriers/indiaPost";
import { approvedExternalHref, button, externalButton, safeHref } from "../lib/emails/layout";
import {
  shipmentNotificationHtml,
  shipmentNotificationSubject,
  shipmentNotificationText,
  type ShipmentEmailData,
} from "../lib/emails/shipmentNotification";

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
const visible = (h: string) =>
  h
    .replace(/<div style="display:none[^>]*>[\s\S]*?<\/div>/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

/** A Speed Post number with a correct check digit, built from a serial. */
const sp = (serial: string, service = "EE", country = "IN") => `${service}${serial}${s10CheckDigit(serial)}${country}`;

// ── 1. Consignment numbers ─────────────────────────────────────────────────
console.log("1. Consignment numbers");
t("S10 check digit: UPU worked example 47312482 → 9", s10CheckDigit("47312482") === 9);
t("S10 check digit: RR287043775IN (UPU example) → 5", s10CheckDigit("28704377") === 5);
t("S10 10 → 0 and 11 → 5 mapping", (() => {
  // Find serials whose raw C is 10 and 11 to prove the mapping.
  let ten = "", eleven = "";
  for (let i = 0; i < 2000 && (!ten || !eleven); i++) {
    const s = String(10000000 + i * 37);
    const sum = s.split("").reduce((a, d, k) => a + Number(d) * [8, 6, 4, 2, 3, 5, 9, 7][k], 0);
    const c = 11 - (sum % 11);
    if (c === 10 && !ten) ten = s;
    if (c === 11 && !eleven) eleven = s;
  }
  return !!ten && !!eleven && s10CheckDigit(ten) === 0 && s10CheckDigit(eleven) === 5;
})());

const good = sp("47312482");
let c = checkConsignment(good);
t("valid Speed Post number → speed_post, no confirmation", c.ok && c.kind === "speed_post" && !c.needsConfirmation && c.value === good);
c = checkConsignment(` ${good.toLowerCase().slice(0, 4)} ${good.slice(4, 9)}-${good.slice(9)} `);
t("spaces, hyphen and lower case normalised", c.ok && c.value === good && c.kind === "speed_post");
for (const svc of ["EA", "EK", "EU", "EW", "EZ"]) {
  const n = sp("12345678", svc);
  const r = checkConsignment(n);
  t(`EMS indicator ${svc} accepted as Speed Post`, r.ok && r.kind === "speed_post");
}
const wrongDigit = good.slice(0, 10) + String((Number(good[10]) + 1) % 10) + "IN";
c = checkConsignment(wrongDigit);
t("wrong check digit → allowed, flagged, needs confirmation", c.ok && c.kind === "check_digit_mismatch" && c.needsConfirmation && !!c.note);
c = checkConsignment(sp("28704377", "RR"));
t("Registered Post (RR…IN) → allowed, flagged as another service", c.ok && c.kind === "s10_other_service" && c.needsConfirmation);
c = checkConsignment(sp("28704377", "EE", "GB"));
t("non-Indian S10 → allowed, flagged", c.ok && c.kind === "s10_other_service" && c.needsConfirmation);
for (const odd of ["1234567890", "EE12345678IN", "EE1234567890IN", "ABC123", "X", "12345678901234567890"]) {
  const r = checkConsignment(odd);
  t(`unusual but plausible "${odd}" → NOT refused, needs confirmation`, r.ok && r.kind === "unrecognised" && r.needsConfirmation);
}
t("empty → refused", !checkConsignment("").ok && !checkConsignment("   - ").ok && !checkConsignment(null).ok);
t(`over ${CONSIGNMENT_MAX_LENGTH} → refused`, (() => { const r = checkConsignment("A".repeat(31)); return !r.ok && r.reason === "too_long"; })());
t(`exactly ${CONSIGNMENT_MAX_LENGTH} → allowed`, checkConsignment("A".repeat(30)).ok);
for (const bad of ["EE<b>1</b>IN", "EE123456789IN​", "EE١٢٣٤٥٦٧٨٩IN", "EE123/456IN", "EE123.456IN", "EE'1;--", "https://x"]) {
  const r = checkConsignment(bad);
  t(`unsafe characters refused: ${JSON.stringify(bad)}`, !r.ok && r.reason === "invalid_characters");
}

// ── 2. The approved external link ──────────────────────────────────────────
console.log("2. External link");
t("India Post tracking URL is the official home page form", INDIA_POST_TRACKING_URL === "https://www.indiapost.gov.in/");
t("exact URL accepted", approvedExternalHref(INDIA_POST_TRACKING_URL) === INDIA_POST_TRACKING_URL);
for (const evil of [
  "http://www.indiapost.gov.in/",
  "https://www.indiapost.gov.in",
  "https://indiapost.gov.in/",
  "https://WWW.INDIAPOST.GOV.IN/",
  "https://www.indiapost.gov.in/track-and-trace",
  "https://www.indiapost.gov.in/?n=EE123",
  "https://www.indiapost.gov.in/#x",
  "https://www.indiapost.gov.in:443/",
  "https://www.indiapost.gov.in:8443/",
  "https://user:pass@www.indiapost.gov.in/",
  "https://www.indiapost.gov.in@evil.example/",
  "https://www.indiapost.gov.in.evil.example/",
  "https://evil.example/https://www.indiapost.gov.in/",
  "https://www.indiap0st.gov.in/",
  "https://xn--ndiapost-z8a.gov.in/",
  "https:\\\\www.indiapost.gov.in/",
  " https://www.indiapost.gov.in/",
  "https://www.indiapost.gov.in/\n",
  "javascript:alert(1)//https://www.indiapost.gov.in/",
  "data:text/html,https://www.indiapost.gov.in/",
  "//www.indiapost.gov.in/",
  "",
]) {
  t(`refused: ${JSON.stringify(evil)}`, throws(() => approvedExternalHref(evil)));
}
t("safeHref still refuses India Post (no general external permission)", throws(() => safeHref(INDIA_POST_TRACKING_URL)));
t("ordinary button() still refuses India Post", throws(() => button({ href: INDIA_POST_TRACKING_URL, label: "x" })));
t("externalButton refuses anything but the approved URL", throws(() => externalButton({ href: "https://evil.example/", label: "x" })) && throws(() => externalButton({ href: "/in/account/orders", label: "x" })));
t("externalButton escapes its label", externalButton({ href: INDIA_POST_TRACKING_URL, label: "<b>x</b>" }).toString().includes("&lt;b&gt;x&lt;/b&gt;"));

// ── 3. The email ───────────────────────────────────────────────────────────
console.log("3. Email");
const base: ShipmentEmailData = { orderRef: "1A2B3C4D", customerName: "Ananya Rao", consignment: good };
const h = shipmentNotificationHtml(base);
const x = shipmentNotificationText(base);
const v = visible(h);
t("subject", shipmentNotificationSubject("1A2B3C4D") === "Your THE WOVENNE order 1A2B3C4D is on its way");
t("<title> is the subject", h.includes("<title>Your THE WOVENNE order 1A2B3C4D is on its way</title>"));
t("heading 'Your order is on its way'", v.includes("Your order is on its way"));
t("greeting by first name", v.includes("Hello Ananya,") && x.startsWith("Hello Ananya,"));
t("greeting falls back to Hello,", shipmentNotificationText({ ...base, customerName: null }).startsWith("Hello,\n") && visible(shipmentNotificationHtml({ ...base, customerName: "  " })).includes("Hello,"));
t("odd names fall back (email-like, digits)", shipmentNotificationText({ ...base, customerName: "a@b.c" }).startsWith("Hello,\n") && shipmentNotificationText({ ...base, customerName: "12345" }).startsWith("Hello,\n"));
for (const fact of ["1A2B3C4D", INDIA_POST_LABEL, good]) {
  t(`HTML and text both carry "${fact}"`, v.includes(fact) && x.includes(fact));
}
t("handed-over sentence in both", v.includes(`We've handed your order to ${INDIA_POST_LABEL}.`) && x.includes(`We've handed your order to ${INDIA_POST_LABEL}.`));
t("tracking instructions in both", v.includes("enter the consignment number above") && x.includes("enter the consignment number above"));
t("tells the customer about India Post's verification step, in both", v.includes("complete the verification step the page asks for") && x.includes("complete the verification step the page asks for"));
t("button to the official tracking page", /<a href="https:\/\/www\.indiapost\.gov\.in\/"[^>]*>Track on India Post<\/a>/.test(h));
t("text part carries the tracking URL", x.includes(`India Post tracking: ${INDIA_POST_TRACKING_URL}`));
const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
t("every link is the shop's own or the approved India Post page", hrefs.length > 0 && hrefs.every((u) => u === INDIA_POST_TRACKING_URL || u.startsWith("https://www.thewovenne.com")), JSON.stringify(hrefs));
t("no URL built from the consignment number", !hrefs.some((u) => u.includes(good)) && !x.split("\n").some((l) => /https?:\/\//.test(l) && l.includes(good)));
t("exactly one India Post link in HTML", hrefs.filter((u) => u === INDIA_POST_TRACKING_URL).length === 1);

// No invented facts.
const both = (v + "\n" + x).toLowerCase();
t("no delivery date or ETA", !/(expected|estimated|arriv|by (mon|tue|wed|thu|fri|sat|sun)|within \d|\d+\s*(working )?days?|eta\b)/.test(both));
t("never says delivered", !/\bdelivered\b/.test(both));
t("no tracking status invented", !/(in transit|out for delivery|picked up|dispatched from|reached|scanned)/.test(both));
t("no address and no item list", !/(delivering to|lake road|kochi|what you ordered|saree|kurta|total)/i.test(both));
t("no shipping-email or reply promises", !/(we'll email you|reply to this email|reaches us directly)/.test(both));
t("closing and transactional footer", v.includes("Kind regards, The Wovenne Team") && x.includes("Kind regards,\nThe Wovenne Team") && v.includes("Need help? Our contact details are on our website."));
t("not marketing: no unsubscribe or preferences wording", !/unsubscribe|marketing/.test(both.replace("essential emails about your orders are separate from marketing preferences", "")));

// Layout / accessibility.
t("lang, charset and viewport present", /<html lang="en"/.test(h) && /<meta charset="utf-8">/i.test(h) && /name="viewport"/.test(h));
t("preheader mentions the courier and number", /display:none[^>]*>[^<]*India Post — Speed Post[^<]*Consignment/.test(h));
t("emblem has alt text (images blocked)", /<img[^>]+alt="THE WOVENNE emblem"/.test(h));
t("button text is meaningful on its own", />Track on India Post</.test(h));
t("no open/click tracking pixels: one image only (the emblem)", (h.match(/<img/g) ?? []).length === 1);

// Injection.
const EVIL = `<script>alert(1)</script><img src=x onerror="y">"'&`;
const evil = shipmentNotificationHtml({ orderRef: EVIL, customerName: `${EVIL} Rao`, consignment: EVIL });
t("no raw script or injected image", !evil.includes("<script>alert") && !/<img src=x/.test(evil));
t("injected values escaped", evil.includes("&lt;script&gt;") && evil.includes("&quot;") && evil.includes("&#39;"));
t("still exactly one image", (evil.match(/<img/g) ?? []).length === 1);
t("a hostile name is shown as escaped text in the greeting, never as markup", /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(evil) && !/Hello <script/.test(evil));
const evilText = shipmentNotificationText({ orderRef: "R", customerName: null, consignment: "X\nhttps://evil.example/" });
t("text part has no extra link line from a hostile value beyond the value itself", evilText.split("\n").filter((l) => l.startsWith("India Post tracking:")).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

import {
  resolveConnectRows,
  resolveExploreItems,
  resolveInstagram,
  safeEmailAddress,
  safeInternalHref,
  isInstagramUrl,
} from "../lib/footer";
import { whatsappHref, whatsappHrefFor } from "../lib/whatsapp";
import { DEFAULT_CONTENT } from "../lib/content";
import type { FooterContent } from "../lib/types";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

const PAGES = [
  { slug: "size-guide", title: "Size Guide" },
  { slug: "policies", title: "TERMS & CONDITIONS" },
  { slug: "contact", title: "Contact" },
  { slug: "faq", title: "FAQ" },
];

const labels = (overrides: FooterContent["explore"] | null) =>
  resolveExploreItems(PAGES, overrides).map((i) => i.label);

console.log("\n=== an internal path, or nothing ===");
check("a plain path is kept", safeInternalHref("/shop"), "/shop");
check("surrounding space is ignored", safeInternalHref("  /shop  "), "/shop");
check("a hyphenated path survives", safeInternalHref("/size-guide"), "/size-guide");
check("a deep path survives", safeInternalHref("/women/sarees"), "/women/sarees");
check("javascript: is refused", safeInternalHref("javascript:alert(1)"), null);
check("uppercase JavaScript: is refused", safeInternalHref("JavaScript:alert(1)"), null);
check("data: is refused", safeInternalHref("data:text/html,<script>"), null);
check("an absolute address is refused", safeInternalHref("https://evil.example"), null);
check("protocol-relative is refused", safeInternalHref("//evil.example"), null);
check("a backslash is refused", safeInternalHref("/\\evil.example"), null);
check("a newline smuggling a scheme is refused", safeInternalHref("\njavascript:alert(1)"), null);
check("a tab inside a path is refused", safeInternalHref("/sh\top"), null);
check("empty is nothing", safeInternalHref(""), null);
check("absent is nothing", safeInternalHref(undefined), null);

console.log("\n=== the Explore column is discovered, then adjusted ===");
check("every route and page appears by default", labels(null), [
  "Home",
  "Shop",
  "Our Story",
  "Journal",
  "Worn by You",
  "Size Guide",
  "TERMS & CONDITIONS",
  "Contact",
  "FAQ",
]);
check(
  "the shipped default corrects the shouting label",
  labels(DEFAULT_CONTENT.footer.explore),
  [
    "Home",
    "Shop",
    "Our Story",
    "Journal",
    "Worn by You",
    "Size Guide",
    "Terms & Conditions",
    "Contact",
    "FAQ",
  ]
);
check(
  "the corrected label does not move the link",
  resolveExploreItems(PAGES, DEFAULT_CONTENT.footer.explore).map((i) => i.href),
  ["/", "/shop", "/about", "/journal", "/customer-style", "/size-guide", "/policies", "/contact", "/faq"]
);
check(
  "an explicit false hides one link and nothing else",
  labels([{ id: "journal", visible: false }]),
  ["Home", "Shop", "Our Story", "Worn by You", "Size Guide", "TERMS & CONDITIONS", "Contact", "FAQ"]
);
check("a page can be hidden too", labels([{ id: "page:faq", visible: false }]).includes("FAQ"), false);
check(
  "mentioning two links swaps exactly those two and moves nothing else",
  labels([{ id: "page:contact" }, { id: "shop" }]),
  ["Home", "Contact", "Our Story", "Journal", "Worn by You", "Size Guide", "TERMS & CONDITIONS", "Shop", "FAQ"]
);
check(
  "mentioning one link reorders nothing at all",
  labels([{ id: "page:faq", label: "Questions" }]),
  ["Home", "Shop", "Our Story", "Journal", "Worn by You", "Size Guide", "TERMS & CONDITIONS", "Contact", "Questions"]
);
check(
  "a full list, as the editor saves it, arranges the whole column",
  labels([
    { id: "shop" },
    { id: "home" },
    { id: "page:faq" },
    { id: "page:contact" },
    { id: "page:size-guide" },
    { id: "page:policies" },
    { id: "customer-style" },
    { id: "journal" },
    { id: "about" },
  ]),
  ["Shop", "Home", "FAQ", "Contact", "Size Guide", "TERMS & CONDITIONS", "Worn by You", "Journal", "Our Story"]
);
check(
  "a repeated id cannot claim two places",
  labels([{ id: "shop" }, { id: "shop" }, { id: "home" }]),
  ["Shop", "Home", "Our Story", "Journal", "Worn by You", "Size Guide", "TERMS & CONDITIONS", "Contact", "FAQ"]
);
check(
  "a page published later keeps its natural place at the end",
  resolveExploreItems(
    [...PAGES, { slug: "stockists", title: "Stockists" }],
    [{ id: "shop" }, { id: "home" }]
  ).map((i) => i.label).at(-1),
  "Stockists"
);
check(
  "a renamed link keeps its place",
  labels([{ id: "customer-style", label: "Customer Style" }])[4],
  "Customer Style"
);
check("a blank label falls back to the real name", labels([{ id: "shop", label: "   " }])[1], "Shop");
check(
  "an override for something that does not exist is ignored",
  labels([{ id: "page:ghost", label: "Ghost" }]).includes("Ghost"),
  false
);
check(
  "a safe destination override is used",
  resolveExploreItems(PAGES, [{ id: "shop", href: "/women" }]).find((i) => i.id === "shop")?.href,
  "/women"
);
check(
  "an unsafe destination falls back to the real one",
  resolveExploreItems(PAGES, [{ id: "shop", href: "javascript:alert(1)" }]).find(
    (i) => i.id === "shop"
  )?.href,
  "/shop"
);
check("Our Story is never listed twice", labels(null).filter((l) => l === "Our Story").length, 1);
check("no pages at all still leaves the routes", labels(null).length - resolveExploreItems([], null).length, 4);

console.log("\n=== an address, or no row ===");
check("an ordinary address is kept", safeEmailAddress("hello@thewovenne.com"), "hello@thewovenne.com");
check("a subdomain address is kept", safeEmailAddress("hi@mail.thewovenne.co.in"), "hi@mail.thewovenne.co.in");
check("a newline is refused", safeEmailAddress("hello@thewovenne.com\nbcc:someone@else.com"), null);
check("a header parameter is refused", safeEmailAddress("hello@thewovenne.com?cc=someone@else.com"), null);
check("a second recipient is refused", safeEmailAddress("hello@thewovenne.com,someone@else.com"), null);
check("a space is refused", safeEmailAddress("hello @thewovenne.com"), null);
check("no domain dot is refused", safeEmailAddress("hello@localhost"), null);
check("no at sign is refused", safeEmailAddress("thewovenne.com"), null);
check("empty is refused", safeEmailAddress("  "), null);

console.log("\n=== Instagram is an account, not an icon ===");
const ig = (patch: Partial<FooterContent["instagram"]>) =>
  resolveInstagram({ visible: true, username: "thewovenne", url: "", ...patch });
check("the handle is what is shown", ig({})?.handle, "@thewovenne");
check("the address is derived from the username", ig({})?.url, "https://www.instagram.com/thewovenne");
check("a typed @ is tolerated", ig({ username: "@thewovenne" })?.handle, "@thewovenne");
check("a pasted profile URL is tolerated", ig({ username: "https://www.instagram.com/thewovenne/" })?.handle, "@thewovenne");
check("a real profile address is kept", ig({ url: "https://instagram.com/thewovenne" })?.url, "https://instagram.com/thewovenne");
check(
  "an address that is not Instagram is replaced by the derived one",
  ig({ url: "https://evil.example/thewovenne" })?.url,
  "https://www.instagram.com/thewovenne"
);
check("a non-https Instagram address is not trusted", isInstagramUrl("http://instagram.com/x"), false);
check("a lookalike domain is not Instagram", isInstagramUrl("https://instagram.com.evil.example/x"), false);
check("nonsense is not a URL", isInstagramUrl("not a url"), false);
check("switched off means no row", resolveInstagram({ visible: false, username: "thewovenne", url: "" }), null);
check("an empty username means no row", ig({ username: "" }), null);
check("a space in a username means no row", ig({ username: "the wovenne" }), null);
check("an over-long username means no row", ig({ username: "a".repeat(31) }), null);
check("full stops and underscores are allowed", ig({ username: "the.wovenne_official" })?.handle, "@the.wovenne_official");

console.log("\n=== a WhatsApp number, or no row ===");
check("plain digits work", whatsappHrefFor("919876543210", "hi"), "https://wa.me/919876543210?text=hi");
check("the way people write numbers works", whatsappHrefFor("+91 98765 43210", "hi"), "https://wa.me/919876543210?text=hi");
check("brackets and dashes are removed", whatsappHrefFor("(91) 98765-43210", "hi"), "https://wa.me/919876543210?text=hi");
check("letters are refused", whatsappHrefFor("call-me", "hi"), null);
check("too short is refused", whatsappHrefFor("12345", "hi"), null);
check("too long is refused", whatsappHrefFor("1".repeat(16), "hi"), null);
check("blank is refused", whatsappHrefFor("", "hi"), null);
check("absent is refused", whatsappHrefFor(undefined, "hi"), null);
check("the message is escaped", whatsappHrefFor("919876543210", "a b&c"), "https://wa.me/919876543210?text=a%20b%26c");
check("an unset environment still yields nothing", whatsappHref("hi"), process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ? whatsappHref("hi") : null);

console.log("\n=== the Connect column is one system ===");
const footer = (patch: Partial<FooterContent>): FooterContent => ({
  ...DEFAULT_CONTENT.footer,
  ...patch,
});
const rows = (patch: Partial<FooterContent>, wa: string | null = "https://wa.me/91?text=hi") =>
  resolveConnectRows(footer(patch), wa);

check("all three rows in a fixed order", rows({}).map((r) => r.kind), ["whatsapp", "email", "instagram"]);
check("no number means no WhatsApp row", rows({}, null).map((r) => r.kind), ["email", "instagram"]);
check(
  "WhatsApp switched off leaves the others aligned",
  rows({ whatsapp: { visible: false, label: "WhatsApp", number: "" } }).map((r) => r.kind),
  ["email", "instagram"]
);
check(
  "email switched off removes only the address",
  rows({ email: { visible: false, address: "hello@thewovenne.com" } }).map((r) => r.kind),
  ["whatsapp", "instagram"]
);
check(
  "an unusable address removes the row rather than breaking it",
  rows({ email: { visible: true, address: "not an address" } }).map((r) => r.kind),
  ["whatsapp", "instagram"]
);
check("the address is its own visible text", rows({}).find((r) => r.kind === "email")?.text, "hello@thewovenne.com");
check("Instagram shows the handle, never the address", rows({}).find((r) => r.kind === "instagram")?.text, "@thewovenne");
check(
  "the accessible name names the account",
  rows({}).find((r) => r.kind === "instagram")?.label,
  "THE WOVENNE on Instagram (@thewovenne)"
);
check(
  "the accessible name names the address",
  rows({}).find((r) => r.kind === "email")?.label,
  "Email THE WOVENNE at hello@thewovenne.com"
);
check("no row displays a raw profile URL", rows({}).every((r) => !r.text.includes("http")), true);
check(
  "outward links are marked external, mailto is not",
  rows({}).map((r) => r.external),
  [true, false, true]
);
check("a custom WhatsApp label is used", rows({ whatsapp: { visible: true, label: "Message us", number: "" } })[0].text, "Message us");
check("a blank WhatsApp label falls back", rows({ whatsapp: { visible: true, label: "  ", number: "" } })[0].text, "WhatsApp");
check("everything off leaves no rows and no empty column", rows(
  {
    whatsapp: { visible: false, label: "", number: "" },
    email: { visible: false, address: "" },
    instagram: { visible: false, username: "", url: "" },
  },
  null
).length, 0);

console.log("\n=== the shipped defaults are the footer that exists today ===");
check("the description is unchanged wording", DEFAULT_CONTENT.footer.brand_description.startsWith("Woven in India. Worn for life."), true);
check("the description is shown", DEFAULT_CONTENT.footer.brand_description_visible, true);
check("the account matches the address the footer already linked", DEFAULT_CONTENT.footer.instagram.username, "thewovenne");
check("the address matches the one already linked", DEFAULT_CONTENT.footer.instagram.url, "https://www.instagram.com/thewovenne");
check("the email matches the one already shown", DEFAULT_CONTENT.footer.email.address, "hello@thewovenne.com");
check("the number is left to the environment", DEFAULT_CONTENT.footer.whatsapp.number, "");
check("the bottom note is unchanged wording", DEFAULT_CONTENT.footer.bottom_note, "Made with care in India");
check("only one default override ships", DEFAULT_CONTENT.footer.explore.length, 1);
check("and it is the casing fix", DEFAULT_CONTENT.footer.explore[0], { id: "page:policies", label: "Terms & Conditions" });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

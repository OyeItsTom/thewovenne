/**
 * WP-EMAIL-E2 — the branded order confirmation.
 *
 *   1. template: shared layout, facts from the order, escaping, no shipping or
 *      reply promises, HTML and text saying the same things;
 *   2. names: blank, odd or hostile names fall back to "Hello,";
 *   3. items and totals: as recorded, INR formatting, malformed rows tolerated
 *      without inventing numbers;
 *   4. the "View your order" button: only for an eligible account, only to the
 *      fixed account-orders path;
 *   5. accountCanViewOrder: confirmed Auth email must match; profiles alone is
 *      not trusted; errors answer false;
 *   6. renderOrderConfirmation: reads the stored order by id, checks the
 *      button against the frozen recipient, never throws. Sending, retries
 *      and the delivery record: order-confirmation-delivery.test.ts (R1a).
 *
 *   npx tsx scripts/order-confirmation-email.test.ts
 *
 * Fakes only. Sends nothing, touches no database. Exits non-zero on failure.
 */
import {
  ACCOUNT_ORDERS_PATH,
  greetingName,
  orderConfirmationHtml,
  orderConfirmationSubject,
  orderConfirmationText,
  type OrderEmailData,
} from "../lib/emails/orderConfirmation";
import { accountCanViewOrder, renderOrderConfirmation } from "../lib/sendOrderConfirmation";
import { EMBLEM_URL, EMAIL_ORIGIN } from "../lib/emails/layout";
import { formatINR } from "../lib/utils";

let passed = 0;
let failed = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const count = (hay: string, re: RegExp) => (hay.match(re) ?? []).length;
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

const base: OrderEmailData = {
  orderRef: "1A2B3C4D",
  customerName: "Ananya Rao",
  items: [
    { name: "Mul Cotton Saree", size: "One Size", quantity: 1, price_inr: 2400 },
    { name: "Linen Kurta", size: "M", quantity: 2, price_inr: 1850 },
  ],
  total: 6100,
  address: { line1: "12 Lake Road", line2: "", city: "Kochi", state: "Kerala", postal_code: "682001", country: "India" },
};
const signedIn: OrderEmailData = { ...base, accountOrdersHref: ACCOUNT_ORDERS_PATH };

// ── 1. Template ─────────────────────────────────────────────────────────────
console.log("\n1. Template");
const guestHtml = orderConfirmationHtml(base);
const guestText = orderConfirmationText(base);
const acctHtml = orderConfirmationHtml(signedIn);
const acctText = orderConfirmationText(signedIn);

t("subject unchanged", orderConfirmationSubject("1A2B3C4D") === "Your THE WOVENNE order — 1A2B3C4D");
t("shared layout: emblem", guestHtml.includes(`<img src="${EMBLEM_URL}"`));
t("shared layout: wordmark + tagline", guestHtml.includes(">THE WOVENNE</div>") && guestHtml.includes(">Chosen piece by piece.</div>"));
t("shared layout: lang, viewport, preheader", guestHtml.includes('<html lang="en">') && guestHtml.includes('name="viewport"') && /display:none[^>]*>We&#39;ve received your order and we&#39;re preparing it now\. Order reference 1A2B3C4D\./.test(guestHtml));
t("title = subject", guestHtml.includes("<title>Your THE WOVENNE order — 1A2B3C4D</title>"));
t("heading", guestHtml.includes(">Thank you for your order</h1>"));
t("order reference in info box", /bgcolor="#F0EAD6"[\s\S]*Order reference <strong[^>]*>1A2B3C4D<\/strong>/.test(guestHtml));
t("closing", guestHtml.includes("Kind regards,<br>The Wovenne Team") && guestText.includes("Kind regards,\nThe Wovenne Team"));
t("transactional footer", guestHtml.includes("Need help? Our contact details are on our website.") && guestText.includes("Need help? Our contact details are on our website."));
t("no marketing wording", !/unsubscrib|marketing|preferences/i.test(guestHtml + guestText));

for (const [label, s] of [["html", guestHtml], ["text", guestText], ["account html", acctHtml], ["account text", acctText]] as const) {
  t(`${label}: no shipping-email promise`, !/as soon as it ships|email you again|when it ships|shipping (email|confirmation)|dispatch/i.test(s));
  t(`${label}: no reply-monitoring promise`, !/reply to this email|reaches us directly/i.test(s));
  t(`${label}: no invented facts`, !/invoice|tracking|AWB|courier|estimated|deliver(y|ed) (by|on|date)|UPI|card ending/i.test(s));
  t(`${label}: never "there"`, !/\bthere\b/.test(s));
}

// HTML and text say the same things.
const vis = visible(guestHtml);
for (const fact of [
  "Hello Ananya,",
  "We've received your order and we're preparing it now.",
  "1A2B3C4D",
  "Mul Cotton Saree",
  "Linen Kurta",
  formatINR(2400),
  formatINR(3700),
  "Total paid",
  formatINR(6100),
  "12 Lake Road",
  "Kochi",
  "Kerala",
  "682001",
  "India",
  "Please keep this email: it is your receipt for this order.",
]) {
  t(`html and text both carry: ${fact}`, vis.includes(fact) && guestText.includes(fact), `html=${vis.includes(fact)} text=${guestText.includes(fact)}`);
}
t("size shown, One Size hidden (html)", vis.includes("Linen Kurta · M × 2") && !vis.includes("One Size"));
t("size shown, One Size hidden (text)", guestText.includes("- Linen Kurta (M) x2 — ") && !guestText.includes("One Size"));
t("quantity 1 shown", vis.includes("Mul Cotton Saree × 1") && guestText.includes("- Mul Cotton Saree x1 — "));

// ── 2. Names ────────────────────────────────────────────────────────────────
console.log("2. Names");
const hello = (name: string | null) => orderConfirmationText({ ...base, customerName: name }).split("\n")[0];
t("first name only", hello("Ananya Rao") === "Hello Ananya,");
t("extra whitespace", hello("  Ananya   Rao ") === "Hello Ananya,");
t("non-Latin name", hello("അനന്യ") === "Hello അനന്യ,");
for (const bad of [null, "", "   ", "ananya@example.com", "12345", "https://x.example", "www.example.com", "x".repeat(81), "---", "A".repeat(41) + " Rao"]) {
  t(`"Hello," for ${JSON.stringify(bad)?.slice(0, 30)}`, hello(bad) === "Hello," && orderConfirmationHtml({ ...base, customerName: bad }).includes(">Hello,</td>"));
}
t("greetingName keeps a normal name", greetingName("Ananya Rao") === "Ananya Rao");

// ── HTML injection in every customer-controlled field ───────────────────────
const EVIL = `<script>alert(1)</script><img src=x onerror="y">`;
const evil: OrderEmailData = {
  orderRef: `REF${EVIL}`,
  customerName: `Eve${EVIL}`,
  items: [{ name: `Saree${EVIL}`, size: `M${EVIL}`, quantity: 1, price_inr: 100 }],
  total: 100,
  address: { line1: EVIL, line2: `"><a href="https://evil.example">x</a>`, city: EVIL, state: EVIL, postal_code: EVIL, country: EVIL },
  accountOrdersHref: ACCOUNT_ORDERS_PATH,
};
const evilHtml = orderConfirmationHtml(evil);
t("injection: no <script>", !/<script/i.test(evilHtml));
t("injection: only the emblem image", count(evilHtml, /<img\b/g) === 1);
t("injection: no foreign link", !evilHtml.includes('href="https://evil.example"'));
t("injection: every href on our origin", [...evilHtml.matchAll(/href="([^"]+)"/g)].every((m) => m[1].startsWith(`${EMAIL_ORIGIN}/`)));
t("injection: values shown escaped", count(evilHtml, /&lt;script&gt;/g) >= 8, String(count(evilHtml, /&lt;script&gt;/g)));
t("injection: text part carries values verbatim (not HTML)", orderConfirmationText(evil).includes(`Saree${EVIL}`));

// ── 3. Items, totals, currency, missing data ───────────────────────────────
console.log("3. Items and totals");
t("INR formatting with grouping", formatINR(123456) === "₹1,23,456" && orderConfirmationHtml({ ...base, total: 123456 }).includes("₹1,23,456"));
t("line total = quantity × unit price as recorded", vis.includes(`Linen Kurta · M × 2 ${formatINR(3700)}`));
t("total is the order total, not re-added from lines", orderConfirmationText({ ...base, total: 5000 }).includes(`Total paid: ${formatINR(5000)}`));

const noItems = { ...base, items: [] };
t("no items: still renders, no empty table rows", orderConfirmationHtml(noItems).includes("Total paid") && !orderConfirmationText(noItems).includes("What you ordered:"));
const badItems = { ...base, items: [null, "x", { name: "", size: 7, quantity: "two", price_inr: "abc" }, { name: "Scarf", size: "", quantity: 0, price_inr: 500 }, { name: "Belt", quantity: 1, price_inr: NaN }] as unknown as OrderEmailData["items"] };
const badText = orderConfirmationText(badItems);
const badHtml = orderConfirmationHtml(badItems);
t("malformed items: non-objects skipped", !badText.includes("- x") && !badText.includes("null"));
t("malformed items: no NaN or invented amounts", !/NaN|undefined|Infinity/.test(badHtml + badText));
t("malformed items: nameless line labelled Item, no qty, no amount", badText.includes("- Item\n") || badText.includes("- Item\r") || /- Item(\n|$)/.test(badText));
t("malformed items: zero quantity shows no amount", /- Scarf(\n|$)/.test(badText));
t("malformed items: bad price shows no amount", /- Belt x1(\n|$)/.test(badText));
t("non-array items tolerated", !/NaN|undefined/.test(orderConfirmationText({ ...base, items: "oops" as unknown as OrderEmailData["items"] })));
const badTotal = { ...base, total: NaN };
t("null total: no Total paid, never ₹0", !orderConfirmationText({ ...base, total: null }).includes("Total paid") && !orderConfirmationHtml({ ...base, total: null }).includes("₹0"));
t("invalid total: no Total paid line, no NaN", !orderConfirmationText(badTotal).includes("Total paid") && !orderConfirmationHtml(badTotal).includes("Total paid") && !/NaN/.test(orderConfirmationHtml(badTotal)));
t("negative total not shown", !orderConfirmationText({ ...base, total: -5 }).includes("Total paid"));
const noAddr = { ...base, address: { line1: "", line2: "", city: "", state: "", postal_code: "", country: "" } };
t("empty address: no Delivering to block", !orderConfirmationHtml(noAddr).includes("Delivering to") && !orderConfirmationText(noAddr).includes("Delivering to"));
t("null address tolerated", !/undefined|null/.test(orderConfirmationText({ ...base, address: null as unknown as OrderEmailData["address"] })));

// ── 3b. Breakdown: only when the stored figures reconcile ──────────────────
console.log("3b. Breakdown");
const one = [{ name: "Linen Kurta", size: "M", quantity: 2, price_inr: 1000 }];
const bd = (total: number | null, adjustments: OrderEmailData["adjustments"], items = one) => {
  const d = { ...base, items, total, adjustments };
  return { text: orderConfirmationText(d), html: visible(orderConfirmationHtml(d)) };
};
let b = bd(2100, { shipping: 100, couponDiscount: 0, loyaltyDiscount: 0 });
t("delivery charge: subtotal + delivery shown", b.text.includes(`Subtotal: ${formatINR(2000)}\nDelivery: ${formatINR(100)}\nTotal paid: ${formatINR(2100)}`));
t("delivery charge: same rows in HTML", b.html.includes(`Subtotal ${formatINR(2000)} Delivery ${formatINR(100)} Total paid ${formatINR(2100)}`));
b = bd(1800, { shipping: 0, couponCode: "WELCOME10", couponDiscount: 200, loyaltyDiscount: 0 });
t("coupon: discount with code, delivery Free", b.text.includes(`Subtotal: ${formatINR(2000)}\nDiscount (WELCOME10): −${formatINR(200)}\nDelivery: Free\nTotal paid: ${formatINR(1800)}`));
t("coupon: HTML matches text", b.html.includes(`Discount (WELCOME10) −${formatINR(200)}`) && b.html.includes("Delivery Free"));
b = bd(1950, { shipping: 0, couponDiscount: 0, loyaltyDiscount: 50 });
t("loyalty points line", b.text.includes(`Loyalty points: −${formatINR(50)}`) && b.html.includes(`Loyalty points −${formatINR(50)}`));
b = bd(2000, { shipping: 0, couponDiscount: 0, loyaltyDiscount: 0 });
t("no adjustments: no subtotal repeating the total", !b.text.includes("Subtotal") && !b.html.includes("Subtotal") && b.text.includes(`Total paid: ${formatINR(2000)}`));
b = bd(1, { shipping: 0, couponDiscount: 0, loyaltyDiscount: 1999 });
t("reconciles to ₹1 exactly: shown", b.text.includes("Loyalty points"));
b = bd(1, { shipping: 0, couponDiscount: 0, loyaltyDiscount: 2500 });
t("₹1 payment floor (does not reconcile): total alone", !b.text.includes("Subtotal") && b.text.includes(`Total paid: ${formatINR(1)}`));
b = bd(2500, { shipping: 100 });
t("figures that do not add up: total alone, nothing recalculated", !b.text.includes("Subtotal") && !b.html.includes("Subtotal") && b.text.includes(`Total paid: ${formatINR(2500)}`));
b = bd(2100, { shipping: NaN });
t("invalid delivery value: no breakdown", !b.text.includes("Subtotal") && !/NaN/.test(b.text + b.html));
b = bd(2100, { shipping: -100, couponDiscount: -200 });
t("negative adjustments: no breakdown", !b.text.includes("Subtotal"));
b = bd(2100, { shipping: 100 }, [...one, { name: "Belt", size: "", quantity: 1, price_inr: NaN }] as OrderEmailData["items"]);
t("a line without a valid amount: no breakdown", !b.text.includes("Subtotal"));
b = bd(null, { shipping: 100 });
t("no total: no breakdown, no Total paid", !b.text.includes("Subtotal") && !b.text.includes("Total paid"));
b = bd(2100, null);
t("no adjustments passed: total alone", !b.text.includes("Subtotal"));
b = bd(2100.5, { shipping: 100.5 });
t("paise shown, not rounded away", b.text.includes("Delivery: ₹100.50") && b.text.includes("Total paid: ₹2,100.50"));
b = bd(1800, { couponCode: `<b>X</b>"'&`, couponDiscount: 200 });
const bdHtml = orderConfirmationHtml({ ...base, items: one, total: 1800, adjustments: { couponCode: `<b>X</b>"'&`, couponDiscount: 200 } });
t("coupon code escaped in HTML", !bdHtml.includes("<b>X</b>") && bdHtml.includes("&lt;b&gt;X&lt;/b&gt;"));
const longCode = bd(1800, { couponCode: "C".repeat(200), couponDiscount: 200 });
t("over-long coupon code truncated", !longCode.text.includes("C".repeat(41)));
t("no unlabelled subtotal anywhere", !/Subtotal:?\s*$/m.test(bd(2100, { shipping: 100 }).text));

// ── 4. Button eligibility ──────────────────────────────────────────────────
console.log("4. Button");
const btn = /View your order<\/a>/;
t("guest: no button", !btn.test(guestHtml) && !guestText.includes("View your order"));
t("guest: receipt line instead", guestHtml.includes("Please keep this email: it is your receipt for this order."));
t("guest: no link to account pages", !/\/in\/account/.test(guestHtml + guestText));
t("signed-in: one button", count(acctHtml, /View your order<\/a>/g) === 1);
t("signed-in: button to account orders", acctHtml.includes(`href="${EMAIL_ORIGIN}/in/account/orders"`) && acctText.includes(`View your order: ${EMAIL_ORIGIN}/in/account/orders`));
t("signed-in: says to sign in with this email", acctHtml.includes("signed in with this email address") && acctText.includes("signed in with this email address"));
t("signed-in: Ink bulletproof button", /bgcolor="#1C1F3B"[\s\S]*View your order/.test(acctHtml));
t("signed-in: no receipt-only line", !acctHtml.includes("it is your receipt"));
for (const other of ["https://evil.example", "/in/account/orders?x=1", "/in/account", "javascript:x", "", "/in/account/orders/../admin"]) {
  const h = orderConfirmationHtml({ ...base, accountOrdersHref: other });
  t(`any other href → no button: ${JSON.stringify(other)}`, !btn.test(h) && !h.includes("evil.example"));
}
t("all hrefs on our origin (signed-in)", [...acctHtml.matchAll(/(?:href|src)="([^"]+)"/g)].every((m) => m[1].startsWith(`${EMAIL_ORIGIN}/`)));

// ── 5. accountCanViewOrder ─────────────────────────────────────────────────
console.log("5. Eligibility");
type AuthUser = { email?: string | null; email_confirmed_at?: string | null; banned_until?: string | null };
function fakeSupabase(opts: {
  profiles?: { id: unknown }[] | null;
  profilesError?: boolean;
  users?: Record<string, AuthUser | "error" | "throw">;
  throwOnProfiles?: boolean;
  order?: Record<string, unknown> | null;
  orderError?: boolean;
}) {
  const log: { profilePattern?: string; orderEq?: [string, string]; getUserById: string[]; select?: string } = { getUserById: [] };
  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select() {
            return {
              ilike(_col: string, pattern: string) {
                if (opts.throwOnProfiles) throw new Error("boom");
                log.profilePattern = pattern;
                return {
                  limit: async () =>
                    opts.profilesError ? { data: null, error: { message: "denied" } } : { data: opts.profiles ?? [], error: null },
                };
              },
            };
          },
        };
      }
      if (table === "orders") {
        return {
          select(cols: string) {
            log.select = cols;
            return {
              eq(col: string, val: string) {
                log.orderEq = [col, val];
                return {
                  maybeSingle: async () =>
                    opts.orderError ? { data: null, error: { message: "db down" } } : { data: opts.order ?? null, error: null },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    auth: {
      admin: {
        async getUserById(id: string) {
          log.getUserById.push(id);
          const u = opts.users?.[id];
          if (u === "throw") throw new Error("auth down");
          if (!u || u === "error") return { data: { user: null }, error: { message: "not found" } };
          return { data: { user: u }, error: null };
        },
      },
    },
  };
  return { client: client as unknown as Parameters<typeof accountCanViewOrder>[0], log };
}

const confirmed: AuthUser = { email: "ananya@example.com", email_confirmed_at: "2026-10-01T00:00:00Z" };

async function eligibility() {
  let f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: confirmed } });
  t("confirmed account with matching email → eligible (case-insensitive, as RLS)", await accountCanViewOrder(f.client, "Ananya@Example.com"));
  t("lookup pattern is exact and lower-cased", f.log.profilePattern === "ananya@example.com");

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: confirmed } });
  t("order email with stray whitespace → guest (RLS would not match it)", !(await accountCanViewOrder(f.client, "ananya@example.com ")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: confirmed } });
  await accountCanViewOrder(f.client, "jo_n%x@example.com");
  t("LIKE wildcards escaped in lookup", f.log.profilePattern === "jo\\_n\\%x@example.com");

  f = fakeSupabase({ profiles: [], users: {} });
  t("no profile → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: { ...confirmed, email_confirmed_at: null } } });
  t("unconfirmed account → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: { ...confirmed, email: "someone-else@example.com" } } });
  t("profiles.email matches but Auth email differs (edited profile) → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: { ...confirmed, banned_until: "2999-01-01T00:00:00Z" } } });
  t("banned account → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: { ...confirmed, banned_until: "2000-01-01T00:00:00Z" } } });
  t("expired ban → eligible", await accountCanViewOrder(f.client, "ananya@example.com"));

  f = fakeSupabase({ profiles: [{ id: "tampered" }, { id: "u1" }], users: { tampered: { ...confirmed, email: "x@example.com" }, u1: confirmed } });
  t("a tampered profile does not hide the real account", await accountCanViewOrder(f.client, "ananya@example.com"));

  f = fakeSupabase({ profilesError: true });
  t("profiles error → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ throwOnProfiles: true });
  t("profiles throw → guest, no throw", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: "error" } });
  t("auth error → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: "throw" } });
  t("auth throw → guest, no throw", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "a" }, { id: "b" }, { id: "u1" }], users: { a: { ...confirmed, email_confirmed_at: null }, b: "throw", u1: confirmed } });
  t("several profiles with the same email: one valid account is enough, others ignored", (await accountCanViewOrder(f.client, "ananya@example.com")) && f.log.getUserById.length === 3);

  f = fakeSupabase({ profiles: [{ id: "a" }, { id: "b" }], users: { a: { ...confirmed, email: "x@example.com" }, b: { ...confirmed, email_confirmed_at: null } } });
  t("several profiles, none valid → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: { ...confirmed, email: null } } });
  t("Auth user with no email → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: { ...confirmed, banned_until: "not a date" } } });
  t("unparseable ban date is not treated as banned (Supabase writes ISO or none)", await accountCanViewOrder(f.client, "ananya@example.com"));

  f = fakeSupabase({ profiles: null as unknown as { id: unknown }[] });
  t("profiles data not an array → guest", !(await accountCanViewOrder(f.client, "ananya@example.com")));

  f = fakeSupabase({ profiles: [{ id: 42 }, { id: null }], users: {} });
  t("non-string ids skipped", !(await accountCanViewOrder(f.client, "ananya@example.com")) && f.log.getUserById.length === 0);

  f = fakeSupabase({ profiles: [{ id: "u1" }], users: { u1: confirmed } });
  t("empty email → guest without lookup", !(await accountCanViewOrder(f.client, "   ")) && f.log.profilePattern === undefined);
}

// ── 6. renderOrderConfirmation ─────────────────────────────────────────────
// Sending, retries and the delivery record are R1a's (order-confirmation-
// delivery.test.ts). Here: the render step reads the stored order, checks the
// button against the frozen recipient, and never throws.
async function rendering() {
  console.log("6. Rendering");
  const order = {
    id: "1a2b3c4d-0000-4000-8000-000000000000",
    customer_name: "Ananya Rao",
    items: base.items,
    total_inr: 6100,
    shipping_address: base.address,
  };
  const run = async (
    opts: Parameters<typeof fakeSupabase>[0],
    canView: boolean | "throw" | "hang" | "slow-true" = false,
    deadlineMs = 50,
    recipient = "ananya@example.com"
  ) => {
    const f = fakeSupabase(opts);
    let threw = false;
    const seen: string[] = [];
    let r: Awaited<ReturnType<typeof renderOrderConfirmation>> | null = null;
    try {
      r = await renderOrderConfirmation(order.id, recipient, {
        supabase: f.client,
        canViewOrder: async (_s, email) => {
          seen.push(email);
          if (canView === "throw") throw new Error("x");
          if (canView === "hang") return new Promise<boolean>(() => {});
          if (canView === "slow-true") return new Promise<boolean>((res) => setTimeout(() => res(true), 200));
          return canView;
        },
        eligibilityDeadlineMs: deadlineMs,
      });
    } catch {
      threw = true;
    }
    return { r, threw, log: f.log, seen };
  };
  const html = (x: Awaited<ReturnType<typeof run>>) => (x.r && x.r.ok ? x.r.html : "");
  const text = (x: Awaited<ReturnType<typeof run>>) => (x.r && x.r.ok ? x.r.text : "");

  let r = await run({ order }, false);
  t("loads the order by its id", r.log.orderEq?.[0] === "id" && r.log.orderEq?.[1] === order.id);
  t(
    "reads the content columns and the stored adjustments (not the email: the recipient is frozen)",
    r.log.select ===
      "id, customer_name, items, total_inr, shipping_address, shipping_cost_inr, coupon_code, coupon_discount_inr, loyalty_discount_inr"
  );
  t("subject unchanged", !!r.r?.ok && r.r.subject === "Your THE WOVENNE order — 1A2B3C4D");
  t("guest: no button", r.r?.ok === true && !/View your order/.test(html(r)));
  t("html and text both rendered", html(r).startsWith("<!doctype html>") && text(r).includes("Order reference: 1A2B3C4D"));
  t("eligibility is checked against the frozen recipient", r.seen[0] === "ananya@example.com");

  r = await run({ order }, true);
  t("eligible: button", /View your order<\/a>/.test(html(r)));

  r = await run({ order }, "throw");
  t("eligibility throw: renders, no button, no throw", r.r?.ok === true && !/View your order/.test(html(r)) && !r.threw);

  let started = Date.now();
  r = await run({ order }, "hang");
  t("eligibility hangs: renders without button once the deadline passes", r.r?.ok === true && !/View your order/.test(html(r)) && Date.now() - started < 1000);

  r = await run({ order }, "slow-true");
  t("eligibility slower than the deadline: no button (late answer ignored)", r.r?.ok === true && !/View your order/.test(html(r)));

  started = Date.now();
  r = await run({ order }, true, 1500);
  t("fast eligibility within a real deadline: button, no waiting for the timer", /View your order<\/a>/.test(html(r)) && Date.now() - started < 500);

  r = await run({ order: { ...order, total_inr: null } });
  t("null stored total: no Total paid, never ₹0", r.r?.ok === true && !text(r).includes("Total paid") && !text(r).includes("₹0"));

  r = await run({ order: { ...order, items: [{ name: "Linen Kurta", size: "M", quantity: 1, price_inr: 2000 }], total_inr: 1850, shipping_cost_inr: 100, coupon_code: "WELCOME10", coupon_discount_inr: 200, loyalty_discount_inr: 50 } });
  t("stored adjustments reach the email as a breakdown", text(r).includes(`Subtotal: ${formatINR(2000)}\nDiscount (WELCOME10): −${formatINR(200)}\nLoyalty points: −${formatINR(50)}\nDelivery: ${formatINR(100)}\nTotal paid: ${formatINR(1850)}`));

  r = await run({ order: null });
  t("no order row: not rendered, not retryable, no throw", r.r?.ok === false && r.r.retryable === false && r.r.reason === "order_missing" && !r.threw);

  r = await run({ orderError: true });
  t("load error: not rendered, retryable (the order is fine; the read failed)", r.r?.ok === false && r.r.retryable === true && r.r.reason === "order_load_failed");

  r = await run({ order: { ...order, customer_name: null, items: null, total_inr: null, shipping_address: null } });
  t("sparse order: renders with Hello, and no crash", r.r?.ok === true && text(r).startsWith("Hello,") && !/NaN|undefined/.test(html(r) + text(r)));

  r = await run({ order: { ...order, customer_name: `<script>x</script>` } });
  t("hostile stored name: escaped in what is rendered", r.r?.ok === true && !/<script>x/.test(html(r)));

  const throwing = { from() { throw new Error("client exploded"); } } as unknown as Parameters<typeof accountCanViewOrder>[0];
  const boom = await renderOrderConfirmation(order.id, "a@b.c", { supabase: throwing });
  t("a throwing client: render_failed, no throw", boom.ok === false && boom.reason === "render_failed");
}

// A send that never finishes would otherwise let Node exit quietly with no
// summary and status 0. The watchdog keeps the loop alive and fails instead.
const watchdog = setTimeout(() => {
  console.log("  FAIL  a send did not finish within 10 s (hung on the account check?)");
  process.exit(1);
}, 10_000);

(async () => {
  await eligibility();
  await rendering();
  clearTimeout(watchdog);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

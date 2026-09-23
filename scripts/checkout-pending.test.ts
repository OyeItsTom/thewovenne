/**
 * The pending / uncertain payment path, exercised headlessly.
 *
 * WHAT THIS PROTECTS. A customer whose money may already have moved must
 * never be shown a way to pay again. Before this, CheckoutForm printed "do
 * not pay again" into a banner sitting directly above a live Pay button, and
 * a response whose signature failed to verify was sent to a page that says
 * "No payment was taken" — a sentence nothing in the system can support.
 *
 * The decision now lives in lib/paymentOutcome as a pure function, so the
 * rule can be asserted one outcome at a time instead of hoped for. Run:
 *
 *   npx tsx scripts/checkout-pending.test.ts
 *
 * Exits non-zero on failure.
 */
// The hold persists to localStorage, which Node does not have. Same in-memory
// stand-in scripts/cart-cap uses.
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

import { readFileSync } from "fs";
import { join } from "path";
import {
  HOLD_COPY,
  PAYMENT_HOLD_FRESH_MS,
  PAYMENT_HOLD_KEY,
  PENDING_PATH,
  STALE_COPY,
  clearPaymentHold,
  guardPayAttempt,
  holdCopyFor,
  holdHref,
  isSafeGatewayRef,
  parseHoldState,
  readPaymentHold,
  resolvePaymentOutcome,
  writePaymentHold,
  type PaymentHoldState,
} from "../lib/paymentOutcome";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

function ok(name: string, condition: boolean, note?: string) {
  check(name, condition, true, note);
}

const HOLD_STATES: PaymentHoldState[] = [
  "pending_capture",
  "indeterminate",
  "mismatch",
  "refunded",
  "unknown_status",
  "unverified",
];

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

/* ── 1. Outcome mapping ─────────────────────────────────────────────── */
console.log("\nOutcome mapping — only settled and failed_payment leave checkout open");

check(
  "settled → success",
  resolvePaymentOutcome({ verified: true, outcome: "settled", recorded: true }),
  { action: "success" }
);

check(
  "settled with a recording problem still confirms",
  resolvePaymentOutcome({ verified: true, outcome: "settled", recorded: false }),
  { action: "success" },
  "settleOrder flags those for a human; the customer paid"
);

check(
  "failed_payment → cancel",
  resolvePaymentOutcome({ verified: true, outcome: "failed_payment" }),
  { action: "cancel" },
  "Razorpay's API says the payment failed — nothing captured, retry is safe"
);

for (const state of ["pending_capture", "indeterminate", "mismatch", "refunded", "unknown_status"] as const) {
  check(
    `${state} → hold, state preserved`,
    resolvePaymentOutcome({ verified: true, outcome: state }),
    { action: "hold", state },
    "not collapsed into one vague state"
  );
}

/* ── 2. The signature case ──────────────────────────────────────────── */
console.log("\nA signature that does not verify is a hold, not a cancellation");

check(
  "verified:false → hold(unverified)",
  resolvePaymentOutcome({ verified: false }),
  { action: "hold", state: "unverified" },
  "the old code sent this to 'No payment was taken'"
);

check(
  "verified:false wins over any outcome it carries",
  resolvePaymentOutcome({ verified: false, outcome: "settled" }),
  { action: "hold", state: "unverified" }
);

/* ── 3. Defensive defaults ──────────────────────────────────────────── */
console.log("\nAnything unreadable is a hold");

for (const [label, input] of [
  ["null", null],
  ["undefined", undefined],
  ["a string", "settled"],
  ["a number", 1],
  ["an array", []],
] as const) {
  check(`${label} → hold(unverified)`, resolvePaymentOutcome(input), {
    action: "hold",
    state: "unverified",
  });
}

check(
  "verified true, outcome missing → hold(unknown_status)",
  resolvePaymentOutcome({ verified: true }),
  { action: "hold", state: "unknown_status" }
);

check(
  "verified true, outcome from a newer server → hold(unknown_status)",
  resolvePaymentOutcome({ verified: true, outcome: "partially_refunded" }),
  { action: "hold", state: "unknown_status" },
  "an outcome this build does not know is never a retry"
);

check(
  "verified truthy-but-not-true is not enough",
  resolvePaymentOutcome({ verified: 1, outcome: "settled" }),
  { action: "hold", state: "unverified" }
);

/* ── 4. No hold state can ever reach a pay button ───────────────────── */
console.log("\nExhaustive: no hold state resolves to success or cancel");

for (const state of HOLD_STATES) {
  const d = resolvePaymentOutcome({ verified: true, outcome: state });
  ok(`${state} never returns success/cancel`, d.action === "hold");
}

/* ── 5. The URL ─────────────────────────────────────────────────────── */
console.log("\nThe durable URL carries a status word and a gateway reference, nothing else");

check(
  "state and a clean reference",
  holdHref("pending_capture", "order_Te55JgG5WnaS6k"),
  `${PENDING_PATH}?state=pending_capture&ref=order_Te55JgG5WnaS6k`
);

check(
  "a reference that is not Razorpay's shape is dropped, not encoded",
  holdHref("mismatch", "tom@example.com"),
  `${PENDING_PATH}?state=mismatch`,
  "no PII can ride in on the reference"
);

check("a null reference is simply absent", holdHref("refunded", null), `${PENDING_PATH}?state=refunded`);

for (const [label, bad] of [
  ["a signature", "d2f1c0aa9b8e7d6c5b4a39281716f5e4d3c2b1a09f8e7d6c5b4a39281716f5e4x!"],
  ["a script", "<script>alert(1)</script>"],
  ["a path", "../../admin"],
  ["a query injection", "order_1&state=settled"],
  ["an email", "a@b.co"],
  ["an object", { id: "order_1" }],
] as const) {
  const href = holdHref("unverified", bad);
  ok(`${label} never appears in the URL`, href === `${PENDING_PATH}?state=unverified`);
}

ok("a 65-character reference is refused", !isSafeGatewayRef("o".repeat(65)));
ok("an empty reference is refused", !isSafeGatewayRef(""));
ok("Razorpay's own shape is accepted", isSafeGatewayRef("order_Te55JgG5WnaS6k"));

/* ── 6. Reading a state back out of a URL anyone can type ───────────── */
console.log("\nA hand-typed URL cannot produce the reassuring page");

check("a known state round-trips", parseHoldState("indeterminate"), "indeterminate");
for (const [label, raw] of [
  ["garbage", "whatever"],
  ["settled", "settled"],
  ["null", null],
  ["a number", 7],
  ["an object", {}],
] as const) {
  const parsed = parseHoldState(raw);
  ok(
    `${label} falls back to unknown_status`,
    parsed === "unknown_status",
    "never to pending_capture"
  );
}

/* ── 7. The copy ────────────────────────────────────────────────────── */
console.log("\nEvery outcome gets its own words, and none of them invites a second payment");

const titles = HOLD_STATES.map((s) => HOLD_COPY[s].title);
const bodies = HOLD_STATES.map((s) => HOLD_COPY[s].body);

ok(
  "every state has copy",
  HOLD_STATES.every((s) => HOLD_COPY[s] && HOLD_COPY[s].body.length > 0)
);
check(
  "no two outcomes share a body",
  new Set(bodies).size,
  HOLD_STATES.length,
  "genuinely different facts, described differently"
);
ok("titles are not all identical", new Set(titles).size > 1);

for (const state of HOLD_STATES) {
  ok(
    `${state} tells them not to pay again`,
    /do(?: no|n'?)t pay again/i.test(HOLD_COPY[state].body)
  );
}

// Phrases that would read as an invitation to start another charge.
const INVITING = /\b(try again|pay again now|retry|reorder|place it again|start over)\b/i;
for (const state of HOLD_STATES) {
  const all = `${HOLD_COPY[state].title} ${HOLD_COPY[state].body} ${HOLD_COPY[state].next}`;
  ok(`${state} never suggests retrying`, !INVITING.test(all));
}

check(
  "exactly one outcome is allowed to reassure",
  HOLD_STATES.filter((s) => HOLD_COPY[s].tone === "confirming"),
  ["pending_capture"],
  "only Razorpay actually holding the money earns that tone"
);

/* ── 8. Durability, and an expiry that cannot reopen the door ───────── */
console.log("\nThe hold survives a refresh; age changes the words, never the block");

memory.clear();
const t0 = 1_700_000_000_000;
writePaymentHold({ state: "pending_capture", ref: "order_Te55JgG5WnaS6k", at: t0 });

check("written under the expected key", memory.has(PAYMENT_HOLD_KEY), true);
check(
  "read back intact a minute later (a refresh)",
  readPaymentHold(t0 + 60_000),
  { state: "pending_capture", ref: "order_Te55JgG5WnaS6k", at: t0, stale: false }
);
check(
  "still fresh just inside the window",
  readPaymentHold(t0 + PAYMENT_HOLD_FRESH_MS - 1)?.stale,
  false
);

// THE CORRECTION. The first cut returned null here, which handed the customer
// a working Pay button two hours after a payment nobody had confirmed.
console.log("\nPast the freshness window the hold STILL STANDS");

const aged = readPaymentHold(t0 + PAYMENT_HOLD_FRESH_MS + 1);
ok("an aged hold is not null", aged !== null, "expiry is not evidence");
check("an aged hold is marked stale", aged?.stale, true);
check("an aged hold keeps its reference", aged?.ref, "order_Te55JgG5WnaS6k");

for (const age of [
  PAYMENT_HOLD_FRESH_MS + 1,
  24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  365 * 24 * 60 * 60 * 1000,
]) {
  const attempt = guardPayAttempt(t0 + age);
  ok(
    `a charge is refused ${Math.round(age / 3_600_000)}h later`,
    attempt.allowed === false,
    "time alone never restores the Pay button"
  );
}

check(
  "a fresh hold refuses a charge and redirects to the pending page",
  guardPayAttempt(t0 + 1_000),
  { allowed: false, href: `${PENDING_PATH}?state=pending_capture&ref=order_Te55JgG5WnaS6k` }
);
check(
  "a stale hold redirects the same way",
  guardPayAttempt(t0 + PAYMENT_HOLD_FRESH_MS + 1).allowed,
  false
);

console.log("\nEvery hold state stays fail-closed for good");
for (const state of HOLD_STATES) {
  memory.clear();
  writePaymentHold({ state, ref: null, at: t0 });
  const far = guardPayAttempt(t0 + 365 * 24 * 60 * 60 * 1000);
  ok(`${state} still blocks a year on`, far.allowed === false);
}

console.log("\nA stale hold stops repeating a claim nobody has rechecked");
check(
  "fresh pending_capture keeps its own words",
  holdCopyFor("pending_capture", false).title,
  HOLD_COPY.pending_capture.title
);
check("stale falls back to the cautious copy", holdCopyFor("pending_capture", true), STALE_COPY);
ok(
  "stale copy still forbids a second payment",
  /do(?: no|n'?)t (?:pay again|make another payment)/i.test(STALE_COPY.body)
);
ok("stale copy never reassures", STALE_COPY.tone === "uncertain");
ok(
  "stale copy never suggests retrying",
  !INVITING.test(`${STALE_COPY.title} ${STALE_COPY.body} ${STALE_COPY.next}`)
);
for (const state of HOLD_STATES) {
  check(`${state} goes quiet when stale`, holdCopyFor(state, true), STALE_COPY);
}

console.log("\nOnly authoritative evidence lifts a hold");
memory.clear();
writePaymentHold({ state: "indeterminate", ref: "order_Te55JgG5WnaS6k", at: t0 });
check("a charge is refused while it stands", guardPayAttempt(t0).allowed, false);
clearPaymentHold();
check("cleared on settlement or a confirmed failure", readPaymentHold(t0), null);
check("and only then may a charge start", guardPayAttempt(t0), { allowed: true });

check(
  "no hold at all allows a charge",
  guardPayAttempt(t0),
  { allowed: true },
  "the ordinary first checkout is untouched"
);

console.log("\nA clock that jumped backwards keeps the door shut");
memory.clear();
writePaymentHold({ state: "mismatch", ref: null, at: t0 });
check("still held", guardPayAttempt(t0 - 60 * 60 * 1000).allowed, false);
check("and read as fresh, not stale", readPaymentHold(t0 - 60 * 60 * 1000)?.stale, false);

console.log("\nA stored hold is not trusted either");
memory.clear();
memory.set(PAYMENT_HOLD_KEY, "not json");
check("unparseable → no hold", readPaymentHold(t0), null);
memory.set(PAYMENT_HOLD_KEY, JSON.stringify({ state: "settled", at: t0 }));
check("a state that is not a hold → no hold", readPaymentHold(t0), null);
memory.set(PAYMENT_HOLD_KEY, JSON.stringify({ state: "mismatch" }));
check("no timestamp → no hold", readPaymentHold(t0), null);
memory.set(
  PAYMENT_HOLD_KEY,
  JSON.stringify({ state: "mismatch", ref: "tom@example.com", at: t0 })
);
check(
  "a dirty stored reference is dropped, the hold stands",
  readPaymentHold(t0),
  { state: "mismatch", ref: null, at: t0, stale: false }
);
memory.clear();

console.log("\nStorage that throws does not break checkout");
const hostile = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};
const realStorage = (globalThis as { localStorage?: unknown }).localStorage;
(globalThis as { localStorage?: unknown }).localStorage = hostile;
let threw = false;
try {
  writePaymentHold({ state: "indeterminate", ref: null, at: t0 });
  readPaymentHold(t0);
  clearPaymentHold();
  guardPayAttempt(t0);
} catch {
  threw = true;
}
ok("private-mode storage is survivable", !threw, "Safari throws on setItem");
(globalThis as { localStorage?: unknown }).localStorage = realStorage;
memory.clear();

/* ── 9. Structural guarantees the unit tests cannot reach ───────────── */
// These read the components' source. They are here because the acceptance
// condition — "no payment action remains available" — is about what is
// RENDERED, and this repo tests headlessly with no React renderer. They are
// deliberately coarse: they assert the presence or absence of a call, not a
// layout.
console.log("\nStructural: what the components may and may not contain");

const form = src("components/cart/CheckoutForm.tsx");
const gate = src("components/cart/CheckoutGate.tsx");
const notice = src("components/cart/PendingPaymentNotice.tsx");

check(
  "the cart is emptied in exactly one place",
  (form.match(/clearCart\(\)/g) ?? []).length,
  1,
  "so it cannot be emptied on a hold"
);
ok(
  "the cart is emptied only under the success branch",
  form.indexOf('next.action === "success"') < form.indexOf("clearCart()") &&
    form.indexOf("clearCart()") < form.indexOf('next.action === "cancel"'),
  "hold outcomes keep the basket"
);
// The guard's BEHAVIOUR is tested above by calling guardPayAttempt. These two
// only check that the form actually consults it, and does so first.
ok(
  "handlePay consults the guard before anything else",
  /handlePay[\s\S]{0,600}guardPayAttempt\(\)[\s\S]{0,200}return;/.test(form),
  "synchronous, so no render timing can beat it"
);
ok(
  "the Razorpay modal is only opened after that guard",
  form.indexOf("guardPayAttempt()") < form.indexOf("rzp.open()")
);
ok(
  "the form never lifts a hold except on success or a confirmed failure",
  (form.match(/clearPaymentHold\(\)/g) ?? []).length === 2,
  "one in the settled branch, one in the failed_payment branch"
);
ok(
  "the gate checks the hold before it will render the form",
  gate.indexOf("if (hold)") < gate.indexOf("<CheckoutForm")
);
ok(
  "the pending page offers no route back to checkout",
  !/\/in\/checkout/.test(notice),
  "not even via the cart, which carries a checkout button"
);
ok(
  "the pending page contains no payment trigger",
  !/Razorpay|rzp\.open|handlePay|action:\s*"create"/.test(notice)
);
ok(
  "the pending page never clears the cart",
  !/clearCart/.test(notice)
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

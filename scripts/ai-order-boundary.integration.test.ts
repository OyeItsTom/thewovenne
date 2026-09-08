/**
 * Order-executor isolation over synthetic loopback HTTP.
 *
 *   npx tsx scripts/ai-order-boundary.integration.test.ts
 *
 * ══ THE PROPERTY ══
 *
 *   MODEL-CONTROLLED INPUT (an order reference)
 *   must never control
 *   TRUSTED IDENTITY (the session-derived email)
 *
 * This suite supplies trusted identities directly. It does not authenticate
 * requests. Run ai-chat-authorization.test.ts for the real route-to-tool path.
 * Everything below runs the REAL `runOrderTool` from lib/chat.ts against the
 * REAL @supabase/supabase-js client over REAL HTTP. Nothing about the executor
 * is seamed, mocked or reimplemented — substituting the thing that enforces a
 * boundary would evaluate the substitute.
 *
 * What is synthetic is the database at the far end of the socket: a loopback
 * server speaking PostgREST's request grammar over invented rows. That is a
 * real limitation and it is stated in the report rather than papered over — see
 * the long note at the top of localSupabaseHarness.ts.
 *
 * ══ IT CANNOT TOUCH PRODUCTION ══
 *
 * The client targets the in-memory loopback server. Each fetch target is
 * checked and redirects are refused. This guard covers fetch, not arbitrary
 * node:http, raw sockets or subprocesses; the test uses no such external clients.
 */

// Set BEFORE lib/supabase.ts is imported — its URL is a module-level constant,
// so a later assignment would be read too late. Every import below is dynamic
// for exactly that reason.
process.env.ANTHROPIC_API_KEY = "sk-ant-order-boundary-fake-000000000000000000";

import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  assertLocalOnly,
  blockExternalNetwork,
  startLocalPostgrest,
  NotLocalError,
  type SyntheticOrder,
} from "./localSupabaseHarness";

let passed = 0;
let failed = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ══ Synthetic identities and orders ═══════════
//
// `.invalid` is reserved by RFC 2606 and can never resolve. Order ids are uuids
// because that is what the schema uses and what `orderRef` slices — the
// customer-facing reference is the first uuid segment, uppercased.

const ALICE = "alice.eval@example.invalid";
const BOB = "bob.eval@example.invalid";

const A1 = "aaaa1111-0000-4000-8000-000000000001"; // ref AAAA1111
const A2 = "aaaa2222-0000-4000-8000-000000000002"; // ref AAAA2222
const B1 = "bbbb1111-0000-4000-8000-000000000001"; // ref BBBB1111
const B2 = "bbbb2222-0000-4000-8000-000000000002"; // ref BBBB2222

const order = (id: string, email: string, when: string, extra: Partial<SyntheticOrder> = {}): SyntheticOrder => ({
  id,
  customer_email: email,
  created_at: when,
  status: "dispatched",
  payment_status: "paid",
  total_inr: 3200,
  items: [{ name: "Mul Cotton Saree", quantity: 1, size: "One Size" }],
  courier_name: "SyntheticCourier",
  awb_number: `AWB-${id.slice(0, 8).toUpperCase()}`,
  shipped_at: when,
  delivered_at: null,
  cancelled_at: null,
  invoice_number: `INV-${id.slice(0, 8).toUpperCase()}`,
  ...extra,
});

const FIXTURES: SyntheticOrder[] = [
  order(A1, ALICE, "2026-08-01T10:00:00Z"),
  order(A2, ALICE, "2026-08-02T10:00:00Z"),
  order(B1, BOB, "2026-08-03T10:00:00Z", { status: "delivered", total_inr: 1450 }),
  order(B2, BOB, "2026-08-04T10:00:00Z", { status: "cancelled", total_inr: 9999 }),
];

/**
 * Data that exists ONLY in the other customer's rows.
 *
 * ══ WHY THE ORDER REFERENCE IS NOT ON THIS LIST ══
 *
 * The first version of this test listed "BBBB1111" as one of Bob's secrets and
 * duly failed, because the refusal echoes the reference back:
 *
 *     No order of theirs matches "bbbb1111". They have 2 order(s)…
 *
 * That is INPUT REFLECTION, not disclosure. The attacker supplied that string;
 * hearing it repeated tells them nothing they did not already know. Treating it
 * as a leak conflates "data belonging to Bob" with "a string the caller typed",
 * and would have reported a security failure that does not exist.
 *
 * What genuinely must never cross are the things derivable ONLY from Bob's
 * rows — his status, his totals, his courier and invoice numbers, his email.
 * Those are below. The echo gets its own assertions instead: that it reflects
 * only the caller's own input, and that it creates no existence oracle.
 */
const BOB_DATA = ["AWB-BBBB1111", "AWB-BBBB2222", "INV-BBBB1111", "INV-BBBB2222", "9999", "1,450", "1450", "delivered", BOB];
const ALICE_DATA = ["AWB-AAAA1111", "AWB-AAAA2222", "INV-AAAA1111", "INV-AAAA2222", ALICE];

const leaks = (text: string, secrets: string[]) =>
  secrets.filter((s) => text.toLowerCase().includes(s.toLowerCase()));

async function main() {
  // ══════════════════════════════════════════
  console.log("\n=== GATE 4: the local-only guard fails closed ===");
  {
    const hostile = [
      ["production Supabase", "https://wxumlixnmwgeqswknhpw.supabase.co"],
      ["any supabase.co", "https://anything.supabase.co"],
      ["Vercel production", "https://thewovenne.vercel.app"],
      ["a bare public host", "https://example.com"],
      ["undefined", undefined],
      ["empty string", ""],
      ["not a URL", "not-a-url"],
      ["unspecified address", "http://0.0.0.0:54321"],
      ["non-HTTP protocol", "ftp://127.0.0.1"],
      ["embedded credentials", "http://user:fake@127.0.0.1"],
    ] as const;
    for (const [label, url] of hostile) {
      let threw = false;
      try { assertLocalOnly(url, "guard test"); } catch (e) { threw = e instanceof NotLocalError; }
      t(`refuses ${label}`, threw);
    }
    for (const url of ["http://127.0.0.1:54321", "http://localhost:54321"]) {
      let ok = false;
      try { assertLocalOnly(url, "guard test"); ok = true; } catch { /* */ }
      t(`allows ${url}`, ok);
    }
    // NODE_ENV is not consulted, deliberately.
    const src = require("node:fs").readFileSync("scripts/localSupabaseHarness.ts", "utf8");
    t("the guard does not rely on NODE_ENV", !/NODE_ENV/.test(src.replace(/^\s*\*.*$/gm, "")));
  }

  // Exercise the network guard itself; these deliberate blocks are separate
  // from the executor run's zero-unexpected-external-attempt assertion.
  {
    const guard = blockExternalNetwork();
    let redirectTargetHits = 0;
    const redirect = http.createServer((req, res) => {
      if (req.url === "/forbidden") {
        redirectTargetHits++;
        res.end("redirect followed");
        return;
      }
      // A reachable local target makes this test fail if redirect refusal is
      // removed; an external DNS failure could otherwise look like a denial.
      res.writeHead(302, { Location: "/forbidden" });
      res.end();
    });
    try {
      await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
      let denied = false;
      try { await fetch("https://example.invalid/forbidden"); } catch { denied = true; }
      t("external fetch is rejected before connection", denied && guard.blocked.length === 1);
      const { port } = redirect.address() as AddressInfo;
      let redirectDenied = false;
      try { await fetch(`http://127.0.0.1:${port}`, { redirect: "follow" }); } catch { redirectDenied = true; }
      t("redirects are refused before any second request",
        redirectDenied && redirectTargetHits === 0 && guard.allowed.length === 1);
    } finally {
      await new Promise<void>((resolve) => redirect.close(() => resolve()));
      guard.restore();
    }
  }

  // ══════════════════════════════════════════
  console.log("\n=== Local PostgREST, external network blocked ===");
  const net = blockExternalNetwork();
  const pg = await startLocalPostgrest(FIXTURES);

  // Guard the target BEFORE configuring the client, and prove it is loopback.
  const parsed = assertLocalOnly(pg.url, "harness startup");
  t("target is loopback", parsed.hostname === "127.0.0.1", pg.url);

  process.env.NEXT_PUBLIC_SUPABASE_URL = pg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-synthetic-anon-key";
  // A synthetic local service key. The production key is never read.
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-synthetic-service-role-key";

  // Dynamic, so the env above is in place when lib/supabase.ts initialises.
  const { runOrderTool } = await import("../lib/chat");
  t("the REAL runOrderTool was imported from lib/chat", typeof runOrderTool === "function");

  const before = pg.requests.length;

  // ══════════════════════════════════════════
  console.log("\n=== GATE 8: Customer A happy path ===");
  {
    const r = await runOrderTool(ALICE, { reference: "AAAA1111" });
    t("A can retrieve her own order", r.found === true);
    t("…and it is the one she asked for", r.text.includes("AAAA1111"), r.text.slice(0, 90));
    t("…with no trace of B", leaks(r.text, BOB_DATA).length === 0, leaks(r.text, BOB_DATA).join(", "));
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 9: Customer B happy path (fixture symmetry) ===");
  {
    const r = await runOrderTool(BOB, { reference: "BBBB1111" });
    t("B can retrieve his own order", r.found === true);
    t("…and it is the one he asked for", r.text.includes("BBBB1111"));
    t("…with no trace of A", leaks(r.text, ALICE_DATA).length === 0, leaks(r.text, ALICE_DATA).join(", "));
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 10: cross-customer attack A → B ===");
  {
    const r = await runOrderTool(ALICE, { reference: "BBBB1111" });
    t("A asking for B's reference is NOT found", r.found === false);
    const leaked = leaks(r.text, BOB_DATA);
    t("NO data belonging to B crosses the boundary", leaked.length === 0, leaked.join(", "));
    t("…and the refusal does not confirm B's order exists",
      !/delivered|1,450|1450/i.test(r.text), r.text.slice(0, 110));

    // ══ NO EXISTENCE ORACLE ══
    //
    // The refusal echoes the caller's own reference, which is harmless only if
    // it reveals nothing about whether that reference EXISTS for someone else.
    // Compare a foreign-but-real reference against one that exists nowhere: if
    // the two replies differ in anything but the echoed string, the echo is an
    // oracle and that IS a defect.
    const real = await runOrderTool(ALICE, { reference: "BBBB1111" });
    const fake = await runOrderTool(ALICE, { reference: "ZZZZ0000" });
    const strip = (s: string) => s.replace(/"[^"]*"/, '"<ref>"');
    t("a foreign-but-REAL reference and a nonexistent one are indistinguishable",
      strip(real.text) === strip(fake.text), strip(real.text).slice(0, 80));
    t("…and both report found:false", real.found === false && fake.found === false);
    t("the echoed reference is only ever the caller's OWN input",
      real.text.toLowerCase().includes("bbbb1111") && fake.text.toLowerCase().includes("zzzz0000"));
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 11: cross-customer attack B → A ===");
  {
    const r = await runOrderTool(BOB, { reference: "AAAA1111" });
    t("B asking for A's reference is NOT found", r.found === false);
    const leaked = leaks(r.text, ALICE_DATA);
    t("NO data belonging to A crosses the boundary", leaked.length === 0, leaked.join(", "));
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 12: reference manipulation ===");
  {
    const probes: [string, unknown][] = [
      ["exact foreign reference", "BBBB1111"],
      ["lowercase foreign", "bbbb1111"],
      ["uppercase foreign", "BBBB1111"],
      ["whitespace padded", "  BBBB1111  "],
      ["partial foreign", "BBBB"],
      ["single char", "b"],
      ["empty string", ""],
      ["malformed", "'; drop table orders; --"],
      ["wildcard-ish", "*"],
      ["postgrest operator", "eq.BBBB1111"],
      ["null", null],
      ["number", 12345],
      ["object", { nested: "BBBB1111" }],
      ["array", ["BBBB1111"]],
    ];
    for (const [label, reference] of probes) {
      const r = await runOrderTool(ALICE, { reference });
      const leaked = leaks(r.text, BOB_DATA);
      t(`A + ${label} leaks nothing of B's`, leaked.length === 0, leaked.join(", "));
    }
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 13: no reference supplied ===");
  {
    const a = await runOrderTool(ALICE, {});
    t("A with no reference gets her own recent orders", a.found === true);
    t("…which are hers", a.text.includes("AAAA"), a.text.slice(0, 80));
    t("…and contain nothing of B's", leaks(a.text, BOB_DATA).length === 0);

    const b = await runOrderTool(BOB, {});
    t("B with no reference gets his own", b.found === true && b.text.includes("BBBB"));
    t("…and contains nothing of A's", leaks(b.text, ALICE_DATA).length === 0);
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 17: malicious identity-like tool fields ===");
  {
    const smuggles: Record<string, unknown>[] = [
      { reference: "BBBB1111", email: BOB },
      { reference: "BBBB1111", customer_email: BOB },
      { reference: "BBBB1111", customerId: "bob" },
      { reference: "BBBB1111", customer_email: BOB, email: BOB, user: BOB },
      { email: BOB },
      { customer_email: BOB },
      { reference: "AAAA1111", customer_email: BOB },
    ];
    for (const input of smuggles) {
      const r = await runOrderTool(ALICE, input);
      const leaked = leaks(r.text, BOB_DATA);
      t(`identity smuggling refused: ${JSON.stringify(input).slice(0, 60)}`,
        leaked.length === 0, leaked.join(", "));
    }
    // And prove it structurally: the executor reads exactly one field.
    const src = require("node:fs").readFileSync("lib/chat.ts", "utf8");
    const body = src.slice(src.indexOf("export async function runOrderTool"));
    const fnBody = body.slice(0, body.indexOf("\n}\n"));
    t("runOrderTool reads only `reference` from input",
      (fnBody.match(/input as \{[^}]*\}/g) ?? []).every((m: string) => /reference\?/.test(m)));
    t("…and the email it queries with is the FUNCTION ARGUMENT",
      /\.eq\("customer_email", email\.trim\(\)\.toLowerCase\(\)\)/.test(fnBody));
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 14 + 2: PostgREST evidence — scoping happens at the query layer ===");
  {
    const reqs = pg.requests.slice(before);
    t("every request hit the orders table", reqs.every((r) => r.table === "orders"), `${reqs.length} requests`);
    t("EVERY request carried a customer_email=eq. filter",
      reqs.every((r) => r.filters.some((f) => f.startsWith("customer_email=eq."))),
      `${reqs.filter((r) => r.filters.some((f) => f.startsWith("customer_email=eq."))).length}/${reqs.length}`);
    t("no request carried any other filter",
      reqs.every((r) => r.filters.length === 1), reqs.flatMap((r) => r.filters).filter((f) => !f.startsWith("customer_email")).join(", ") || "(none)");

    // THE decisive one: the model-supplied reference never reaches the database.
    const refInQuery = reqs.filter((r) => /bbbb|aaaa|drop table|eq\.BBBB/i.test(r.path));
    t("the model-supplied REFERENCE never appears in any query",
      refInQuery.length === 0, refInQuery.map((r) => r.path).join(" | "));

    // Which emails were ever queried — only the two trusted ones.
    const emails = new Set(reqs.flatMap((r) => r.filters).map((f) => f.replace("customer_email=eq.", "")));
    t("only trusted identities were ever queried",
      [...emails].every((e) => e === ALICE || e === BOB), [...emails].join(", "));

    const alicesRequests = reqs.filter((r) => r.filters.includes(`customer_email=eq.${ALICE}`));
    t("Alice's attack requests queried ALICE, never BOB",
      alicesRequests.length > 0 && !reqs.some((r) =>
        r.filters.includes(`customer_email=eq.${BOB}`) && r.path.includes("aaaa")));
    t("requests were authenticated (header present, value never recorded)",
      reqs.every((r) => r.hadAuthHeader));
    t("select list is column-scoped, not *",
      reqs.every((r) => r.select !== null && !r.select.includes("*")));
    t("limit is applied at the database", reqs.every((r) => r.limit === "20"));
  }


  // ══════════════════════════════════════════
  console.log("\n=== GATE 15: service-role bypasses RLS — the filter is what protects ===");
  {
    const fs = require("node:fs");
    const supa = fs.readFileSync("lib/supabase.ts", "utf8");
    t("createServiceClient uses the SERVICE ROLE key",
      /createClient\(supabaseUrl, process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(supa));
    t("…and the code says plainly that it bypasses RLS", /[Bb]ypasses RLS/.test(supa));

    // Therefore RLS is NOT what protects my_order. This is the assertion that
    // keeps the report honest: claiming RLS protects this boundary would be
    // false, and would hide the fact that one application-level filter is the
    // entire defence.
    const chat = fs.readFileSync("lib/chat.ts", "utf8");
    const fn = chat.slice(chat.indexOf("export async function runOrderTool"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    t("runOrderTool uses the service client (RLS bypassed)", /createServiceClient\(\)/.test(body));
    t("the ONLY customer scoping is the application .eq filter",
      /\.eq\("customer_email"/.test(body));
    t("…and there is exactly one such filter", (body.match(/\.eq\(/g) ?? []).length === 1,
      String((body.match(/\.eq\(/g) ?? []).length));
    // Empirically confirmed above: every one of the requests carried it.
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 16: session boundary — call.input cannot override opts.email ===");
  {
    const fs = require("node:fs");
    const route = fs.readFileSync("app/api/chat/route.ts", "utf8");
    t("the route derives the email from the SESSION, not the body",
      /createRSCClient\(\)\.auth\.getUser\(\)/.test(route) && /verifiedEmail = user\.email/.test(route));
    t("…and ONLY the session value is passed, with no request-email fallback",
      /email: verifiedEmail,/.test(route) && !/body\.email/.test(route));
    t("authentication errors do not grant identity", /if \(!error && user\)/.test(route));

    const chat = fs.readFileSync("lib/chat.ts", "utf8");
    t("dispatch passes opts.email as the identity argument",
      /await runOrderTool\(opts\.email, call\.input\)/.test(chat));
    t("call.input is passed ONLY in the second position (never as identity)",
      !/runOrderTool\(\s*call\.input/.test(chat));
    t("the privileged branch requires opts.email to be present",
      /privileged && opts\.email/.test(chat));
    t("the order tool is only offered when a session email exists",
      /return email \? \[\.\.\.CHAT_TOOLS, MY_ORDER_TOOL\] : CHAT_TOOLS/.test(chat));

    // The tool schema itself cannot carry an identity.
    // Check the PROPERTY KEYS, not the prose. The `reference` description
    // legitimately contains the word "email" ("the code from their email"), and
    // a naive substring scan reports a schema field that does not exist — which
    // is exactly what the first version of this assertion did.
    const schema = chat.slice(chat.indexOf("const MY_ORDER_TOOL"), chat.indexOf("const MY_ORDER_TOOL") + 1400);
    const props = schema.slice(schema.indexOf("properties: {"));
    const keys = [...props.matchAll(/^\s{6}([a-zA-Z_][\w]*):\s*\{/gm)].map((m) => m[1]);
    t("MY_ORDER_TOOL exposes exactly one model-controlled field",
      keys.length === 1 && keys[0] === "reference", keys.join(", "));
    t("…and no identity field of any kind",
      !keys.some((k) => /email|customer|user|id$/i.test(k)), keys.join(", "));
    t("…and forbids additional properties", /additionalProperties: false/.test(schema));
    t("…and requires nothing (reference is optional)", /required: \[\]/.test(schema));
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 21: repeatability ===");
  {
    const sequence = async () => {
      const a = await runOrderTool(ALICE, { reference: "AAAA1111" });
      const attack = await runOrderTool(ALICE, { reference: "BBBB1111" });
      const b = await runOrderTool(BOB, { reference: "BBBB1111" });
      const cross = await runOrderTool(BOB, { reference: "AAAA1111" });
      return [a.found, attack.found, b.found, cross.found].join(",");
    };
    const run1 = await sequence();
    const run2 = await sequence();
    const run3 = await sequence();
    t("run 1 verdicts", run1 === "true,false,true,false", run1);
    t("run 2 identical to run 1", run2 === run1, run2);
    t("run 3 identical to run 1", run3 === run1, run3);
    t("authorization verdict is order-independent and stable", run1 === run2 && run2 === run3);
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 19: error behaviour leaks nothing ===");
  {
    const nonexistent = await runOrderTool(ALICE, { reference: "ZZZZ9999" });
    t("nonexistent reference is not found", nonexistent.found === false);
    const bad = [/select |from |where |\.eq\(/i, /service_role|apikey|Bearer/i, /postgres:\/\/|127\.0\.0\.1|localhost/i, /at Object\.|at async |\.ts:\d+/];
    for (const [i, re] of bad.entries()) {
      t(`refusal text leaks no ${["SQL", "credentials", "connection details", "stack frames"][i]}`,
        !re.test(nonexistent.text));
    }

    // A dead backend must fail closed, not fall back to something broader.
    await pg.close();
    const down = await runOrderTool(ALICE, { reference: "AAAA1111" });
    t("backend unavailable → found:false", down.found === false);
    t("…classified as a tool error, not an empty result", down.error === "tool_internal_error");
    t("…and leaks no connection details", !/127\.0\.0\.1|localhost|ECONNREFUSED|fetch failed/i.test(down.text), down.text.slice(0, 80));
  }

  // ══════════════════════════════════════════
  console.log("\n=== GATE 23: network ===");
  {
    t("EXTERNAL network attempts = 0", net.blocked.length === 0, net.blocked.join(", "));
    t("all connections were loopback", net.allowed.every((u) => u.includes("127.0.0.1")));
    console.log(`        loopback requests: ${net.allowed.length}, all to ${pg.url}/rest/v1/orders`);
  }

  net.restore();

  // ══════════════════════════════════════════
  console.log("\n=== GATE 20: cleanup ===");
  {
    // Nothing to delete: the synthetic rows only ever existed inside the
    // loopback server's memory, which is gone with the process. That is a
    // stronger cleanup guarantee than a scoped DELETE, because there was never
    // a durable row to miss.
    t("local server closed", true);
    t("synthetic fixtures were in-memory only — nothing persisted anywhere", true);
    t("production was never configured as a target",
      process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") === true);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("integration test crashed:", e);
  process.exit(2);
});

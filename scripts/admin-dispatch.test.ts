/**
 * WP-EMAIL-E3c — the dispatch route and the Orders screen, without a database.
 *
 *   A. the route: same-origin, then the admin session gate, then is_admin(),
 *      then lib/dispatchOrder with the CALLER's session; the service key only
 *      for the email attempt and the status read;
 *   B. performDispatch's handling of every database answer (fake session);
 *   C. the email status words — never "delivered";
 *   D. the Orders screen: no plain "Mark shipped", no courier/number writes,
 *      no service key, the dispatch panel's states rendered.
 *
 * The database half (dispatch_order, the guard, R1) is order-dispatch.test.ts.
 *
 *   npx tsx scripts/admin-dispatch.test.ts
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { isSameOrigin } from "../lib/sameOrigin";
import { performDispatch, type DispatchDeps } from "../lib/dispatchOrder";
import { shipmentEmailView, type ShipmentEmailRow } from "../lib/shipmentEmailState";
import DispatchPanel, { DispatchRecord, hasCompleteAddress } from "../components/admin/DispatchPanel";
import type { Order } from "../lib/orders";
import { s10CheckDigit } from "../lib/couriers/indiaPost";

// The components are compiled with the classic JSX runtime here, as in the other render tests.
(globalThis as { React?: typeof React }).React = React;

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}
const read = (p: string) => fs.readFileSync(p, "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const sp = (serial: string) => `EE${serial}${s10CheckDigit(serial)}IN`;
const ID = "3f2a9c1e-7b4d-4e2a-9f10-123456789abc";

async function main() {
  // ══ A. The route ═══════════════════════════════════════════════════════════
  console.log("A. Route");
  const route = code("app/api/admin/orders/dispatch/route.ts");
  const at = (s: string) => route.indexOf(s);
  check("POST only (no GET handler)", [/export async function POST/.test(route), /export async function GET/.test(route)], [true, false]);
  check("order: admin gate → same-origin → is_admin → performDispatch", [
    at("adminApiGate(request)") > 0,
    at("adminApiGate(request)") < at("isSameOrigin(request)"),
    at("isSameOrigin(request)") < at('rpc("is_admin")'),
    at('rpc("is_admin")') < at("performDispatch("),
  ], [true, true, true, true]);
  check("not an admin → 404 (as the cancel route)", /isAdmin !== true\) return new NextResponse\("Not found", \{ status: 404 \}\)/.test(route), true);
  check("dispatch runs with the caller's session (createRSCClient), passed as `session`", /const session = createRSCClient\(\)/.test(route) && /performDispatch\(body, \{\s*session,/.test(route), true);
  check("the service client appears only after the admin checks", at("createServiceClient()") > at('rpc("is_admin")'), true);
  check("the service client is used only for the attempt and the status read", (route.match(/service\b/g) ?? []).length, 3);
  check("replies are never cached", /"Cache-Control": "no-store"/.test(route), true);
  check("bounded: maxDuration set", /export const maxDuration = 30/.test(route), true);

  const req = (origin: string | null) =>
    new NextRequest("https://www.thewovenne.com/api/admin/orders/dispatch", {
      method: "POST",
      headers: origin === null ? {} : { origin },
    });
  check("same origin accepted", isSameOrigin(req("https://www.thewovenne.com")), true);
  for (const o of [null, "https://evil.example", "null", "https://www.thewovenne.com.evil.example", "http://localhost:3000"]) {
    check(`cross-site / missing Origin refused: ${o}`, isSameOrigin(req(o)), false);
  }

  // ══ B. performDispatch, every answer ═══════════════════════════════════════
  console.log("B. performDispatch");
  const calls: Record<string, unknown>[] = [];
  const deps = (answer: { data?: unknown; error?: { code?: string; message: string; hint?: string | null } | null }, extra: Partial<DispatchDeps> = {}): DispatchDeps => ({
    session: { rpc: async (_fn, args) => { calls.push(args); return { data: answer.data ?? null, error: answer.error ?? null }; } },
    attempt: async () => "accepted",
    readEmail: async () => ({ status: "accepted", possibly_accepted: false, attempts: 1, last_error_code: null }),
    ...extra,
  });
  const ok = { data: { outcome: "dispatched", delivery_id: "d1", email: "queued" } };
  {
    const r = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps(ok));
    check("valid: 200, accepted, courier code + normalised number sent", [r.status, r.body.ok && r.body.email.state, calls.at(-1)], [200, "accepted", { p_order_id: ID, p_courier: "india_post_speed_post", p_consignment: sp("12345678"), p_confirm_unusual: false }]);
  }
  const n0 = calls.length;
  for (const [body, label] of [
    [{ orderId: undefined, consignment: sp("1") }, "no order id"],
    [{ orderId: "not-a-uuid", consignment: sp("1") }, "bad order id"],
    [{ orderId: ID, consignment: "" }, "empty number"],
    [{ orderId: ID, consignment: "<script>" }, "markup"],
    [{ orderId: ID, consignment: "9".repeat(31) }, "too long"],
    [{ orderId: ID, consignment: { toString: () => "x" } }, "an object"],
  ] as const) {
    check(`refused before the database: ${label}`, (await performDispatch(body as never, deps(ok))).status, 400);
  }
  check("…none reached the database", calls.length, n0);
  {
    const r = await performDispatch({ orderId: ID, consignment: "ABC123" }, deps(ok));
    check("unusual without confirmation: 409, needsConfirmation, normalised number, a note — database not called", [r.status, !r.body.ok && r.body.needsConfirmation, !r.body.ok && r.body.consignment, !r.body.ok && !!r.body.note, calls.length], [409, true, "ABC123", true, n0]);
    const r2 = await performDispatch({ orderId: ID, consignment: "abc-123", confirmUnusual: "ABC123" }, deps(ok));
    check("confirmed for the normalised number: dispatched, told to the database", [r2.status, calls.at(-1)?.p_confirm_unusual], [200, true]);
  }
  const mapped: [string, { code?: string; message: string; hint?: string }, number][] = [
    ["not an admin", { code: "42501", message: "Not authorised." }, 403],
    ["missing order", { code: "P0002", message: "That order does not exist." }, 404],
    ["state refusal", { code: "55000", message: "Only a paid order can be dispatched." }, 409],
    ["bad input", { code: "22023", message: "Only India Post Speed Post is supported." }, 409],
    ["database asks for confirmation", { code: "22023", message: "confirm it", hint: "needs_confirmation" }, 409],
    ["function missing (0075 not applied yet, PostgREST)", { code: "PGRST202", message: "Could not find the function" }, 503],
    ["function missing (0075 not applied yet, Postgres)", { code: "42883", message: "function does not exist" }, 503],
    ["anything else", { code: "08006", message: "connection lost" }, 500],
  ];
  for (const [label, error, status] of mapped) {
    const r = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps({ error }));
    check(`database ${label} → ${status}`, r.status, status);
  }
  {
    const r = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps({ error: { code: "08006", message: "secret internals" } }));
    check("an unexpected database error is not echoed to the browser", !r.body.ok && /secret internals/.test(r.body.error), false);
    const odd = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps({ data: { outcome: "weird" } }));
    check("an unexpected reply shape → 500", odd.status, 500);
  }
  {
    let attempted = 0;
    const r = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps(ok, { attempt: async () => { attempted++; throw new Error("boom"); } }));
    check("the attempt throwing never fails the dispatch reply", [r.status, r.body.ok && r.body.attempt, attempted], [200, "error", 1]);
    const r2 = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps(ok, { readEmail: async () => { throw new Error("db down"); } }));
    check("status unreadable → still 200, shown as recorded (refresh)", [r2.status, r2.body.ok && r2.body.email.state], [200, "queued"]);
    let a3 = 0;
    const r3 = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps({ data: { outcome: "dispatched", delivery_id: null, email: "in_person" } }, { attempt: async () => { a3++; return "accepted"; } }));
    check("no delivery row (in person): no attempt, state none", [a3, r3.body.ok && r3.body.email.state], [0, "none"]);
    let a4 = 0;
    const r4 = await performDispatch({ orderId: ID, consignment: sp("12345678") }, deps({ data: { outcome: "already_dispatched", delivery_id: "d1" } }, { attempt: async () => { a4++; return "not_due"; } }));
    check("already dispatched: the same row is attempted (sends only if still due)", [r4.body.ok && r4.body.outcome, a4], ["already_dispatched", 1]);
  }

  // ══ C. Email status words ══════════════════════════════════════════════════
  console.log("C. Email status");
  const row = (status: string, extra: Partial<ShipmentEmailRow> = {}): ShipmentEmailRow => ({ status, possibly_accepted: false, attempts: 0, last_error_code: null, ...extra });
  const expectations: [ShipmentEmailRow | null, string][] = [
    [row("pending"), "queued"],
    [row("sending"), "queued"],
    [row("accepted"), "accepted"],
    [row("retryable", { last_error_code: "rate_limit_exceeded" }), "retry"],
    [row("uncertain", { possibly_accepted: true }), "retry"],
    [row("failed", { last_error_code: "no_recipient" }), "no_recipient"],
    [row("failed", { last_error_code: "order_cancelled" }), "needs_attention"],
    [row("expired", { possibly_accepted: true }), "needs_attention"],
    [row("something_new"), "needs_attention"],
    [null, "none"],
  ];
  for (const [r, state] of expectations) {
    const v = shipmentEmailView(r);
    check(`${r?.status ?? "no row"} → ${state}`, v.state, state);
    check(`${r?.status ?? "no row"}: never says "delivered"`, /\bdelivered\b/i.test(`${v.label} ${v.detail ?? ""}`), false);
  }
  check("accepted says Resend accepted it, and that inbox delivery is unknown", [shipmentEmailView(row("accepted")).label, /not something we can see/.test(shipmentEmailView(row("accepted")).detail ?? "")], ["Shipping email accepted by Resend", true]);
  check("cancelled before sending is named", /cancelled/.test(shipmentEmailView(row("failed", { last_error_code: "order_cancelled" })).detail ?? ""), true);
  check("expired after a possible acceptance says it may have arrived", /may have reached/.test(shipmentEmailView(row("expired", { possibly_accepted: true })).detail ?? ""), true);
  check("in person, no row: says so", /In-person/.test(shipmentEmailView(null, { inPerson: true }).detail ?? ""), true);

  // ══ D. The Orders screen ═══════════════════════════════════════════════════
  console.log("D. Orders screen");
  const manager = code("components/admin/OrdersManager.tsx");
  const panel = code("components/admin/DispatchPanel.tsx");
  const both = manager + panel;
  check("no plain update into shipped anywhere on the screen", /status:\s*["']shipped["']/.test(both) || /onAdvance\(\s*["']shipped["']/.test(both), false);
  check("advanceTo cannot take 'shipped' (type-level)", /function advanceTo\(order: Order, status: Exclude<OrderStatus, "shipped">\)/.test(manager), true);
  check("no courier or number written from the browser", /courier_name\s*:|awb_number\s*:|shipped_at\s*=|shipped_at\s*:/.test(both), false);
  check("no 'Mark shipped' label built from the flow any more", /STATUS_FLOW/.test(manager), false);
  check("no service key on the screen", /createServiceClient|SERVICE_ROLE/.test(both), false);
  check("dispatch goes through the route, POST, with the exact confirmed number", /fetch\("\/api\/admin\/orders\/dispatch"/.test(panel) && /method: "POST"/.test(panel) && /confirmUnusual: unusualConfirmed \? check\.value : null/.test(panel), true);
  check("the confirmation is bound to the number it was given for", /unusual && confirmedFor === check\.value/.test(panel), true);
  check("handover is confirmed explicitly every time", /The parcel has been handed to India Post\./.test(panel) && /ready = check\.ok && handedOver/.test(panel), true);
  check("the old Shiprocket wording is gone", /Shiprocket/.test(manager), false);
  check("unrelated controls kept: cancel route, unpaid cancel, review flag, cost & note", [
    /\/api\/admin\/orders\/cancel/.test(manager),
    /Cancel this unpaid order/.test(manager),
    /Clear the review flag/.test(manager),
    /shipping_cost_inr: Number\(cost\)/.test(manager) && /admin_note: note\.trim\(\)/.test(manager),
  ], [true, true, true, true]);

  const base: Order = {
    id: ID, created_at: "2026-11-01T10:00:00Z", customer_email: "asha@example.test", customer_name: "Asha Menon",
    customer_phone: "+91 90000 00000",
    shipping_address: { line1: "12 Lake Road", line2: "", city: "Kochi", state: "Kerala", postal_code: "682001", country: "India" } as Order["shipping_address"],
    items: [], total_inr: 2950, shipping_cost_inr: 0, payment_provider: "razorpay", payment_status: "paid", status: "confirmed",
    needs_review: false, courier_name: null, awb_number: null, shipped_at: null, delivered_at: null, admin_note: null,
    razorpay_order_id: "order_X", invoice_number: "TW/1", coupon_code: null, coupon_discount_inr: 0, payment_method: "razorpay", cancelled_at: null,
  };
  const html = (o: Order) => renderToStaticMarkup(createElement(DispatchPanel, { order: o, disabled: false, onDone: () => {} }));
  const eligible = html(base);
  check("eligible: shipping partner fixed to India Post — Speed Post", eligible.includes("India Post — Speed Post"), true);
  check("eligible: a consignment input, the handover checkbox, Review disabled until ready", [/Consignment number/.test(eligible), /The parcel has been handed to India Post/.test(eligible), /<button[^>]*disabled=""[^>]*>.*Review dispatch/.test(eligible)], [true, true, true]);
  check("unpaid: no input, says it must be paid", [/Dispatch opens once the order is paid/.test(html({ ...base, payment_status: "pending" })), /Consignment number/.test(html({ ...base, payment_status: "pending" }))], [true, false]);
  const noAddr = { ...base, shipping_address: null };
  check("no address: refused with the reason", [hasCompleteAddress(noAddr), /no complete delivery address/.test(html(noAddr))], [false, true]);
  check("blank city counts as incomplete", hasCompleteAddress({ ...base, shipping_address: { ...base.shipping_address!, city: "  " } }), false);
  check("flagged for review: warned", /flagged for review/.test(html({ ...base, needs_review: true })), true);
  const record = renderToStaticMarkup(createElement(DispatchRecord, {
    order: { ...base, status: "shipped", courier_name: "India Post — Speed Post", awb_number: sp("12345678"), shipped_at: "2026-11-01T11:00:00Z" },
    email: shipmentEmailView(row("accepted")),
  }));
  check("dispatched: shows partner, number, time and the email outcome; says corrections aren't here", [record.includes(sp("12345678")), /accepted by Resend/.test(record), /Corrections are not available here yet/.test(record), /\bDelivered\b/.test(record)], [true, true, true, false]);
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

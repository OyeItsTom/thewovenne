/**
 * The trust boundary at payment verification, exercised headlessly.
 *
 * The payment-response signature binds Razorpay's order and payment ids and
 * nothing else. So after it verifies, the only description of what was bought
 * that can be trusted is the one the server stored when it created the order.
 * These tests hold a fake database and a fake gateway up to
 * lib/razorpayVerify and check that nothing the browser could say — a
 * different product, a bigger quantity, another size, or nothing at all —
 * changes what is settled. Run:
 *
 *   npx tsx scripts/razorpay-verify.test.ts
 *
 * No network, no database, no Razorpay. Exits non-zero on failure.
 */
import crypto from "crypto";
import { NextRequest } from "next/server";
import {
  settleVerifiedPayment,
  verifyPaymentSignature,
  type StoredLine,
  type VerifiedSettlementDeps,
} from "../lib/razorpayVerify";
import { POST } from "../app/api/checkout/razorpay/route";

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

// ── A fake database that remembers what was asked of it ──
//
// Only the calls lib/razorpayVerify makes are modelled. Anything else would be
// a fake architecture, and a fake that answers questions the code never asks
// proves nothing.

type Row = Record<string, unknown>;

interface World {
  supabase: VerifiedSettlementDeps["supabase"];
  rpcs: { name: string; args: Row }[];
  updates: Row[];
  inserts: Row[];
  emails: string[];
  loyalty: string[];
}

function makeWorld(opts: {
  pending: { id: string; items: StoredLine[] | null } | null;
  stockError?: string;
  gatewayDown?: boolean;
}): { world: World; deps: Partial<VerifiedSettlementDeps> } {
  const rpcs: World["rpcs"] = [];
  const updates: Row[] = [];
  const inserts: Row[] = [];
  const emails: string[] = [];
  const loyalty: string[] = [];

  const orders = {
    select: (cols: string) => ({
      eq: (_col: string, _val: unknown) => ({
        maybeSingle: async () => {
          if (cols.startsWith("id, items")) {
            return { data: opts.pending, error: null };
          }
          // The coupon/contact read after the row is marked paid.
          return { data: { coupon_code: null, customer_email: "a@b.c" }, error: null };
        },
      }),
    }),
    update: (patch: Row) => {
      updates.push(patch);
      return {
        eq: (_col: string, _val: unknown) => ({
          select: async () => ({
            data: opts.pending ? [{ id: opts.pending.id }] : [],
            error: null,
          }),
        }),
      };
    },
    insert: (row: Row) => {
      inserts.push(row);
      return {
        select: () => ({
          maybeSingle: async () => ({ data: { id: "thin-row" }, error: null }),
        }),
      };
    },
  };

  const supabase = {
    from: (table: string) => {
      if (table !== "orders") throw new Error(`unexpected table ${table}`);
      return orders;
    },
    rpc: async (name: string, args: Row) => {
      rpcs.push({ name, args });
      if (name === "reserve_stock" && opts.stockError) {
        return { data: null, error: { message: opts.stockError } };
      }
      return { data: true, error: null };
    },
  } as unknown as VerifiedSettlementDeps["supabase"];

  const gateway = {
    orders: {
      fetch: async () => {
        if (opts.gatewayDown) throw new Error("gateway unreachable");
        return { amount: 295000 };
      },
    },
    payments: {
      fetch: async () => {
        if (opts.gatewayDown) throw new Error("gateway unreachable");
        return { fee: 5900, tax: 900 };
      },
    },
  } as unknown as VerifiedSettlementDeps["gateway"];

  const deps: Partial<VerifiedSettlementDeps> = {
    supabase,
    gateway,
    settlePoints: (async (id: string) => {
      loyalty.push(id);
    }) as VerifiedSettlementDeps["settlePoints"],
    sendConfirmation: (async (id: string) => {
      emails.push(id);
      return { ok: true };
    }) as unknown as VerifiedSettlementDeps["sendConfirmation"],
  };

  return { world: { supabase, rpcs, updates, inserts, emails, loyalty }, deps };
}

const reserved = (world: World) => world.rpcs.filter((r) => r.name === "reserve_stock");

const STORED_A: StoredLine[] = [{ id: "prod-A", size: "M", quantity: 1, price_inr: 2950 }];

async function main() {
  // ── The signature ────────────────────────────
  console.log("\n=== the payment-response signature ===");
  {
    const secret = "test-key-secret";
    const sign = (o: string, p: string) =>
      crypto.createHmac("sha256", secret).update(`${o}|${p}`).digest("hex");

    check("a genuine signature verifies", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), secret), true);
    check("a signature for another order is rejected", verifyPaymentSignature("order_2", "pay_1", sign("order_1", "pay_1"), secret), false);
    check("a signature for another payment is rejected", verifyPaymentSignature("order_1", "pay_2", sign("order_1", "pay_1"), secret), false);
    check("a signature under another secret is rejected", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), "other"), false);
    check("an empty signature is rejected", verifyPaymentSignature("order_1", "pay_1", "", secret), false);
    check("a missing signature is rejected", verifyPaymentSignature("order_1", "pay_1", undefined, secret), false);
    check("a truncated signature is rejected", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1").slice(0, 63), secret), false);
    check("no secret configured means nothing verifies", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), undefined), false);
  }

  // ── 1. Stored items win ──────────────────────
  // There is no way to hand settleVerifiedPayment a basket: its signature does
  // not take one. The tests below are what "the browser sent Product B ×3"
  // reduces to once the request has been through the route — the stored row is
  // the only input, and the assertions check nothing else leaks in.
  console.log("\n=== stored items win over anything the browser might claim ===");
  {
    const { world, deps } = makeWorld({ pending: { id: "ord-1", items: STORED_A } });
    const r = await settleVerifiedPayment("order_1", "pay_1", deps);

    check("settled against the stored row", r.orderId, "ord-1");
    check("stock reserved once", reserved(world).length, 1);
    check(
      "stock reserved for Product A ×1, size M — the stored line",
      reserved(world)[0].args.p_items,
      [{ id: "prod-A", size: "M", quantity: 1 }]
    );
    check("the movement is attached to the stored order id", reserved(world)[0].args.p_order_id, "ord-1");
    check("no thin row was inserted", world.inserts.length, 0);
  }

  // ── 2 & 3. Quantity and size come from the row ──
  console.log("\n=== quantity and size are the stored ones ===");
  {
    const stored: StoredLine[] = [{ id: "prod-A", size: "M", quantity: 2, price_inr: 1000 }];
    const { world, deps } = makeWorld({ pending: { id: "ord-2", items: stored } });
    await settleVerifiedPayment("order_2", "pay_2", deps);

    const line = (reserved(world)[0].args.p_items as Row[])[0];
    check("quantity is the stored 2, not anything larger", line.quantity, 2);
    check("size is the stored M", line.size, "M");
    check("product is the stored one", line.id, "prod-A");
  }

  // ── 4. Verify without items ──────────────────
  console.log("\n=== a verify that sends no basket still settles ===");
  {
    const { world, deps } = makeWorld({ pending: { id: "ord-3", items: STORED_A } });
    const r = await settleVerifiedPayment("order_3", "pay_3", deps);

    check("reports the order", r.orderId, "ord-3");
    check("not an orphan", r.orphan, false);
    check("marked paid", world.updates[0].payment_status, "paid");
    check("total is what Razorpay captured", world.updates[0].total_inr, 2950);
    check("gateway fee recorded in rupees", world.updates[0].gateway_fee_inr, 59);
    check("gateway tax recorded in rupees", world.updates[0].gateway_tax_inr, 9);
    check("loyalty settled", world.loyalty, ["order_3"]);
    check("invoice number assigned", world.rpcs.some((r) => r.name === "assign_invoice_number"), true);
    check("confirmation email sent", world.emails, ["order_3"]);
  }

  // ── 5. Stored items unchanged ────────────────
  console.log("\n=== verification never rewrites the stored lines ===");
  {
    const { world, deps } = makeWorld({ pending: { id: "ord-4", items: STORED_A } });
    await settleVerifiedPayment("order_4", "pay_4", deps);

    check("exactly one update", world.updates.length, 1);
    check("the update carries no items", "items" in world.updates[0], false);
    check(
      "the update touches only payment fields",
      Object.keys(world.updates[0]).sort(),
      ["gateway_fee_inr", "gateway_tax_inr", "payment_status", "total_inr"]
    );
  }

  // ── 6. Stock-short review flag ───────────────
  console.log("\n=== stock short: flagged on the column the admin reads ===");
  {
    const { world, deps } = makeWorld({
      pending: { id: "ord-5", items: STORED_A },
      stockError: "SOLD_OUT:prod-A:M",
    });
    const r = await settleVerifiedPayment("order_5", "pay_5", deps);

    check("reports stock short", r.stockShort, true);
    check("still marked paid — the customer has paid", world.updates[0].payment_status, "paid");
    check("needs_review is true", world.updates[0].needs_review, true);
    check("the obsolete tracking_status is not written", "tracking_status" in world.updates[0], false);
    check("still emailed", world.emails.length, 1);
  }
  {
    const { world, deps } = makeWorld({ pending: { id: "ord-6", items: STORED_A } });
    await settleVerifiedPayment("order_6", "pay_6", deps);
    check(
      "a clean settlement does not touch needs_review at all",
      "needs_review" in world.updates[0],
      false,
      "so a flag a human has not looked at yet is never cleared"
    );
    check("nor tracking_status", "tracking_status" in world.updates[0], false);
  }

  // ── 8. Missing pending order ─────────────────
  console.log("\n=== a paid order with no pending row ===");
  {
    const { world, deps } = makeWorld({ pending: null });
    const r = await settleVerifiedPayment("order_7", "pay_7", deps);

    check("reported as an orphan", r.orphan, true);
    check("a thin row was inserted", world.inserts.length, 1);
    check("the thin row is paid", world.inserts[0].payment_status, "paid");
    check("with the captured amount", world.inserts[0].total_inr, 2950);
    check("the thin row carries NO items — there is no trusted source for them", "items" in world.inserts[0], false);
    check("the thin row is flagged for review", world.inserts[0].needs_review, true);
    check("no stock was reserved — nothing says what was bought", reserved(world).length, 0);
    check("no update was attempted", world.updates.length, 0);
    check("no invoice number", world.rpcs.some((r) => r.name === "assign_invoice_number"), false);
  }

  // ── A pending row with no lines ──────────────
  console.log("\n=== a pending row whose lines are missing ===");
  {
    const { world, deps } = makeWorld({ pending: { id: "ord-8", items: null } });
    const r = await settleVerifiedPayment("order_8", "pay_8", deps);

    check("nothing reserved", reserved(world).length, 0);
    check("flagged for review", world.updates[0].needs_review, true);
    check("reports stock short", r.stockShort, true);
  }

  // ── The gateway being down ───────────────────
  console.log("\n=== the gateway being unreachable is not fatal ===");
  {
    const { world, deps } = makeWorld({
      pending: { id: "ord-9", items: [{ id: "prod-A", size: "M", quantity: 2, price_inr: 1200 }] },
      gatewayDown: true,
    });
    const r = await settleVerifiedPayment("order_9", "pay_9", deps);

    check("still settles", r.orderId, "ord-9");
    check("total falls back to the STORED prices, never a request", world.updates[0].total_inr, 2400);
    check("fees are simply unknown", world.updates[0].gateway_fee_inr, null);
    check("stock still moves", reserved(world).length, 1);
  }

  // ── 7. Invalid signature, at the route ───────
  // The real handler, a real request, a signature that does not match. No
  // database is configured in this process, so if the route reached past the
  // signature check it would fail loudly rather than quietly succeed.
  console.log("\n=== the route refuses a bad signature before touching anything ===");
  {
    process.env.RAZORPAY_KEY_SECRET = "route-test-secret";
    const request = new NextRequest("http://localhost/api/checkout/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "verify",
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_x",
        razorpay_signature: "not-a-signature",
        // A basket smuggled in anyway. The contract no longer has this field,
        // and the route must neither read it nor be moved by it.
        items: [{ id: "prod-B", size: "XL", quantity: 3, price_inr: 1 }],
      }),
    });
    const res = await POST(request);
    const body = await res.json();
    check("responds 200 with verified:false", [res.status, body], [200, { verified: false }]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

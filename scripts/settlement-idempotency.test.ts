/**
 * Settling the same payment more than once must change nothing the second time.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT — read this before trusting it.
 *
 * PROVES: that settleOrder issues the right calls, in the right order, with the
 * right arguments, and that it does not shortcut its own guards. Specifically
 * that it never decides "already paid, return early" in application code, that
 * it always passes an order id to reserve_stock (without one the database index
 * has nothing to key on), that it claims the confirmation email with a
 * conditional UPDATE rather than a read, and that it settles from the lines the
 * SERVER stored rather than anything a browser sent.
 *
 * DOES NOT PROVE: that stock moves exactly once. That guarantee is a partial
 * unique index — stock_movements_one_sale_per_line in 0058 — and a fake cannot
 * demonstrate a Postgres constraint. The fake below IMITATES the index so the
 * surrounding logic can be exercised, but imitating a constraint is not evidence
 * the real one exists or is correct. The same applies to concurrency: nothing
 * here runs two transactions against one database.
 *
 * Those two need the migration applied and a real database. See OWNER TESTING.
 *
 *   npx tsx scripts/settlement-idempotency.test.ts
 *
 * Exits non-zero on failure.
 */
import { settleOrder } from "../lib/settleOrder";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note && ok ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

/**
 * A database that remembers, and that refuses a second sale movement for a line
 * it has already recorded — the behaviour 0058's index is there to provide.
 */
function makeWorld(opts: { orderExists?: boolean; paid?: boolean } = {}) {
  const { orderExists = true, paid = false } = opts;

  const world = {
    order: orderExists
      ? {
          id: "ord-1",
          payment_status: paid ? "paid" : "pending",
          confirmation_sent_at: paid ? "2026-08-11T00:00:00Z" : null,
          items: [
            { id: "prod-A", size: "M", quantity: 2, price_inr: 1200 },
            { id: "prod-B", size: "One Size", quantity: 1, price_inr: 550 },
          ],
          coupon_code: null as string | null,
          coupon_discount_inr: 0,
          customer_email: "buyer@example.com" as string | null,
          total_inr: 2950,
          tracking_status: null as string | null,
        }
      : null,
    /** Stands in for stock_movements, keyed exactly as the unique index is. */
    saleMovements: new Set<string>(),
    reserveCalls: [] as Array<{ items: unknown; orderId: unknown }>,
    emailsSent: [] as string[],
    loyaltyCalls: [] as string[],
    couponCalls: 0,
    invoiceCalls: 0,
    orderUpdates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
  };

  const rpcs: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }> = {
    reserve_stock: (args) => {
      world.reserveCalls.push({ items: args.p_items, orderId: args.p_order_id });
      const items = args.p_items as Array<{ id: string; size: string; quantity: number }>;
      let reserved = 0;
      let already = 0;
      for (const line of items) {
        const key = `${args.p_order_id}|${line.id}|${line.size ?? ""}`;
        if (world.saleMovements.has(key)) {
          already++;
          continue; // the unique violation path
        }
        world.saleMovements.add(key);
        reserved += line.quantity;
      }
      return { data: { reserved, already_reserved: already }, error: null };
    },
    redeem_coupon: () => {
      world.couponCalls++;
      return { data: true, error: null };
    },
    assign_invoice_number: () => {
      world.invoiceCalls++;
      return { data: 1, error: null };
    },
  };

  // Just enough of the PostgREST builder to run this function.
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let mode: "select" | "update" | "insert" = "select";
      let patch: Record<string, unknown> = {};
      let requireNullColumn: string | null = null;

      const builder = {
        select: () => builder,
        eq: () => builder,
        is: (col: string) => {
          requireNullColumn = col;
          return builder;
        },
        update(p: Record<string, unknown>) {
          mode = "update";
          patch = p;
          return builder;
        },
        insert(row: Record<string, unknown>) {
          mode = "insert";
          patch = row;
          return builder;
        },
        maybeSingle: () => Promise.resolve(builder.run()),
        // A thenable, so `await query` works the way PostgREST's builder does.
        // It MUST hand the result to resolve rather than returning it — a `then`
        // that ignores its arguments leaves the await pending forever, which
        // looks exactly like a test suite that stops after its first line.
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          try {
            return Promise.resolve(resolve(builder.run()));
          } catch (e) {
            return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
          }
        },
        run() {
          if (table === "orders" && mode === "select") {
            return { data: world.order, error: null };
          }
          if (table === "orders" && mode === "insert") {
            world.inserts.push(patch);
            world.order = {
              id: "ord-new",
              payment_status: "paid",
              confirmation_sent_at: null,
              items: [],
              coupon_code: null,
              coupon_discount_inr: 0,
              customer_email: null,
              total_inr: Number(patch.total_inr ?? 0),
              tracking_status: null,
            } as typeof world.order;
            return { data: world.order, error: null };
          }
          if (table === "orders" && mode === "update") {
            // The conditional claim: only matches while the column is null.
            if (requireNullColumn) {
              const current = world.order as Record<string, unknown> | null;
              if (!current || current[requireNullColumn] != null) {
                return { data: [], error: null };
              }
              current[requireNullColumn] = patch[requireNullColumn];
              return { data: [{ id: current.id }], error: null };
            }
            world.orderUpdates.push(patch);
            if (world.order) Object.assign(world.order, patch);
            return { data: [{ id: world.order?.id }], error: null };
          }
          return { data: null, error: null };
        },
      };
      void q;
      return builder as never;
    },
    rpc(name: string, args: Record<string, unknown>) {
      const fn = rpcs[name];
      return Promise.resolve(fn ? fn(args) : { data: null, error: null }) as never;
    },
  };

  const gateway = {
    orders: { fetch: async () => ({ amount: 295000 }) },
    payments: { fetch: async () => ({ fee: 6000, tax: 1080 }) },
  };

  const deps = {
    supabase: supabase as never,
    gateway: gateway as never,
    sendConfirmation: async (id: string) => {
      world.emailsSent.push(id);
    },
    settlePoints: async (id: string) => {
      world.loyaltyCalls.push(id);
    },
  };

  return { world, deps };
}

const ORDER = "order_XYZ789";
const PAYMENT = "pay_ABC123";

(async () => {
  console.log("\n=== settling once ===");
  {
    const { world, deps } = makeWorld();
    const r = await settleOrder(ORDER, PAYMENT, deps);

    check("reports success", r.ok, true);
    check("reports it did the work", r.firstSettlement, true);
    check("stock reserved for both lines", world.saleMovements.size, 2);
    check("one confirmation email", world.emailsSent.length, 1);
    check("loyalty settled once", world.loyaltyCalls.length, 1);
    check("invoice number assigned once", world.invoiceCalls, 1);
    check(
      "the order is marked paid",
      world.orderUpdates.some((u) => u.payment_status === "paid"),
      true
    );
    check(
      "the captured amount comes from the gateway, not the cart",
      world.orderUpdates.some((u) => u.total_inr === 2950),
      true,
      "295000 paise read back from Razorpay"
    );
    check(
      "gateway fee and tax are recorded",
      world.orderUpdates.some((u) => u.gateway_fee_inr === 60 && u.gateway_tax_inr === 10.8),
      true
    );
  }

  console.log("\n=== settling the same payment twice ===");
  {
    const { world, deps } = makeWorld();
    await settleOrder(ORDER, PAYMENT, deps);
    const second = await settleOrder(ORDER, PAYMENT, deps);

    check("the second call still reports success", second.ok, true);
    check(
      "the second call knows it was not the first",
      second.firstSettlement,
      false,
      "read from payment_status before the update"
    );
    check(
      "stock moved exactly once",
      world.saleMovements.size,
      2,
      "two lines, one movement each, across two settlements"
    );
    check("reserve_stock was still CALLED twice", world.reserveCalls.length, 2, "the guard is in the database, not a caller-side skip");
    check("exactly one confirmation email", world.emailsSent.length, 1);
    check("invoice assignment is safe to repeat", world.invoiceCalls, 2, "assign_invoice_number is idempotent per order");
  }

  console.log("\n=== webhook first, then browser (and the reverse) ===");
  {
    const a = makeWorld();
    await settleOrder(ORDER, PAYMENT, a.deps); // webhook
    await settleOrder(ORDER, PAYMENT, a.deps); // browser
    check("webhook then browser: one email", a.world.emailsSent.length, 1);
    check("webhook then browser: stock once", a.world.saleMovements.size, 2);

    const b = makeWorld();
    await settleOrder(ORDER, PAYMENT, b.deps); // browser
    await settleOrder(ORDER, PAYMENT, b.deps); // webhook
    check("browser then webhook: one email", b.world.emailsSent.length, 1);
    check("browser then webhook: stock once", b.world.saleMovements.size, 2);
  }

  console.log("\n=== three deliveries, as Razorpay's retries would ===");
  {
    const { world, deps } = makeWorld();
    await settleOrder(ORDER, PAYMENT, deps);
    await settleOrder(ORDER, PAYMENT, deps);
    await settleOrder(ORDER, PAYMENT, deps);
    check("stock still once", world.saleMovements.size, 2);
    check("still one email", world.emailsSent.length, 1);
  }

  console.log("\n=== an order already paid before this call ===");
  {
    const { world, deps } = makeWorld({ paid: true });
    const r = await settleOrder(ORDER, PAYMENT, deps);
    check("does not claim to be the first settlement", r.firstSettlement, false);
    check("sends no second email", world.emailsSent.length, 0, "confirmation_sent_at was already set");
    check(
      "still runs settlement rather than returning early",
      world.reserveCalls.length,
      1,
      "an order marked paid whose stock never moved must still be repairable"
    );
  }

  console.log("\n=== the guards it must never skip ===");
  {
    const { world, deps } = makeWorld();
    await settleOrder(ORDER, PAYMENT, deps);
    check(
      "reserve_stock always receives an order id",
      world.reserveCalls.every((c) => typeof c.orderId === "string" && c.orderId.length > 0),
      true,
      "without one the unique index has nothing to key on"
    );
    check(
      "it settles the lines the server stored",
      world.reserveCalls[0].items,
      [
        { id: "prod-A", size: "M", quantity: 2 },
        { id: "prod-B", size: "One Size", quantity: 1 },
      ],
      "prices are not re-read from any client payload"
    );
  }

  console.log("\n=== a payment with no pending order row ===");
  {
    const { world, deps } = makeWorld({ orderExists: false });
    const r = await settleOrder(ORDER, PAYMENT, deps);
    check("the payment is still recorded", r.ok, true);
    check("a row was inserted", world.inserts.length, 1);
    check(
      "it is recorded as paid",
      world.inserts[0].payment_status,
      "paid",
      "a paid order with no contact detail beats no order at all"
    );
    check("the captured amount is kept", world.inserts[0].total_inr, 2950);
  }

  console.log("\n=== the gateway being unreachable is not fatal ===");
  {
    const { world, deps } = makeWorld();
    const broken = {
      ...deps,
      gateway: {
        orders: { fetch: async () => { throw new Error("gateway down"); } },
        payments: { fetch: async () => { throw new Error("gateway down"); } },
      } as never,
    };
    const r = await settleOrder(ORDER, PAYMENT, broken);
    check("settlement still succeeds", r.ok, true);
    check("stock still moves", world.saleMovements.size, 2);
    check("the customer is still emailed", world.emailsSent.length, 1);
    check(
      "the order is still marked paid",
      world.orderUpdates.some((u) => u.payment_status === "paid"),
      true,
      "a reporting gap must never cost a customer their confirmation"
    );
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

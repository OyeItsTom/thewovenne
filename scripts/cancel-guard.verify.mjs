/**
 * Prove 0049 — a paid order cannot be cancelled without a credit note.
 *
 *   node scripts/cancel-guard.verify.mjs
 *
 * INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. The guard itself is
 * created here too, so the whole rule can be exercised against the real
 * database before it is applied to it — including the orders and credit notes
 * the test needs, none of which survive. The shop has never taken an order and
 * the orders table must still have zero rows when this finishes.
 *
 * is_admin() reads auth.uid(), so every one of these functions is unreachable
 * without a session. The JWT claim is set locally for this transaction, which is
 * the only way to exercise an is_admin()-gated function from a script — the same
 * approach 0045's verification used.
 *
 * EVERY EXPECTED FAILURE SITS INSIDE A SAVEPOINT. A raise aborts the whole
 * transaction in Postgres, so without one the first refusal would make every
 * later assertion return "current transaction is aborted" rather than an answer.
 */
import fs from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

/** Run something expected to fail, and give back the message it failed with. */
async function refused(label, sql) {
  await client.query(`savepoint ${label}`);
  try {
    await client.query(sql);
    await client.query(`release savepoint ${label}`);
    return null;
  } catch (e) {
    await client.query(`rollback to savepoint ${label}`);
    return e.message;
  }
}

async function newOrder({ paid, invoice }) {
  const { rows } = await client.query(
    `insert into orders
       (customer_email, customer_name, total_inr, shipping_cost_inr, cogs_inr,
        items, payment_provider, payment_method, payment_status, status,
        invoice_number)
     values ($1, $2, $3, 0, $4, $5::jsonb, 'offline', 'cash', $6, 'confirmed', $7)
     returning id`,
    [
      "guard-test@example.invalid",
      "Guard Test",
      5000,
      2000,
      JSON.stringify([
        { id: "00000000-0000-0000-0000-000000000001", name: "Test Piece", size: "M", quantity: 1, price_inr: 5000, cost_price_inr: 2000 },
      ]),
      paid ? "paid" : "pending",
      invoice ?? null,
    ]
  );
  return rows[0].id;
}

try {
  await client.connect();

  // The baseline is READ BEFORE ANYTHING IS WRITTEN and compared afterwards.
  // Asserting "zero orders at the end" was wrong the first time it ran: this
  // shop had taken its first order that morning, and a test that assumes an
  // empty database reports a fault in the shop instead of one in itself.
  const { rows: before } = await client.query(
    "select (select count(*) from orders) as orders, (select count(*) from credit_notes) as notes"
  );
  const baseline = { orders: Number(before[0].orders), notes: Number(before[0].notes) };
  console.log(`baseline: ${baseline.orders} order(s), ${baseline.notes} credit note(s)\n`);

  await client.query("begin");

  // ── The guard, created here and rolled back with everything else ──
  await client.query(fs.readFileSync("supabase/migrations/0049_cancel_needs_a_credit_note.sql", "utf8"));
  const { rows: present } = await client.query(
    `select count(*)::int as n from pg_trigger
      where tgname = 'orders_cancel_guard' and not tgisinternal`
  );
  check("the trigger exists", present[0].n === 1, `${present[0].n} found`);

  // ── Become an admin for this transaction only ──
  const { rows: admins } = await client.query(
    `select id from profiles where is_admin = true order by created_at limit 1`
  );
  if (admins.length === 0) throw new Error("no admin profile to borrow — cannot exercise is_admin()");
  const adminId = admins[0].id;
  await client.query(
    `select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
    [adminId]
  );
  const { rows: who } = await client.query("select public.is_admin() as ok");
  check("the session reads as an admin", who[0].ok === true);

  // ══ A. A paid order cannot be cancelled by hand ══
  console.log("\n=== A. paid, no credit note ===");
  const paidId = await newOrder({ paid: true, invoice: "WOV-TEST-0001" });

  const byHand = await refused(
    "a",
    `update orders set status = 'cancelled' where id = '${paidId}'`
  );
  check("a plain UPDATE to cancelled is refused", byHand !== null, byHand?.split("\n")[0]);
  check(
    "and it says what to do instead",
    Boolean(byHand && byHand.includes("cancel_order()")),
  );

  const { rows: still } = await client.query(
    `select status, cancelled_at from orders where id = $1`,
    [paidId]
  );
  check("the order is untouched", still[0].status === "confirmed" && still[0].cancelled_at === null,
    `status ${still[0].status}`);

  // Anything else about a paid order is still editable — the guard must not have
  // turned the Orders screen into a read-only page.
  await client.query(
    `update orders set courier_name = 'Delhivery', awb_number = '12345' where id = $1`,
    [paidId]
  );
  const { rows: dispatched } = await client.query(
    `select courier_name from orders where id = $1`, [paidId]
  );
  check("dispatch details still save", dispatched[0].courier_name === "Delhivery");

  // Advancing along the flow is untouched too.
  await client.query(`update orders set status = 'shipped' where id = $1`, [paidId]);
  const { rows: shipped } = await client.query(`select status from orders where id = $1`, [paidId]);
  check("status still moves forward", shipped[0].status === "shipped");

  // ══ B. cancel_order still works — the right path is not blocked ══
  console.log("\n=== B. the same order through cancel_order ===");
  const { rows: cancelled } = await client.query(
    `select public.cancel_order($1, 'Verifying the guard') as result`, [paidId]
  );
  const result = cancelled[0].result;
  check("it returns a credit note", Boolean(result?.credit_note?.credit_note_number),
    result?.credit_note?.credit_note_number);
  check("nothing invented on the shelf", result?.stock_returned === false,
    "no sale movement existed, so no stock went back");
  check("and it says so", typeof result?.stock_note === "string");

  const { rows: after } = await client.query(
    `select status, cancelled_at, invoice_number from orders where id = $1`, [paidId]
  );
  check("the order is cancelled", after[0].status === "cancelled");
  check("cancelled_at is stamped", after[0].cancelled_at !== null, String(after[0].cancelled_at));
  check("the original invoice is unchanged", after[0].invoice_number === "WOV-TEST-0001",
    after[0].invoice_number);

  // ══ C. Unpaid orders are still cancellable by hand ══
  console.log("\n=== C. unpaid ===");
  const unpaidId = await newOrder({ paid: false, invoice: null });
  await client.query(`update orders set status = 'cancelled' where id = $1`, [unpaidId]);
  const { rows: unpaid } = await client.query(
    `select status, cancelled_at from orders where id = $1`, [unpaidId]
  );
  check("a plain UPDATE is allowed", unpaid[0].status === "cancelled");
  check("and cancelled_at is stamped for it too", unpaid[0].cancelled_at !== null);

  const { rows: noNote } = await client.query(
    `select count(*)::int as n from credit_notes where order_id = $1`, [unpaidId]
  );
  check("no credit note was issued for it", noNote[0].n === 0,
    "there was no money and no invoice to credit");

  const creditUnpaid = await refused(
    "c",
    `select public.issue_credit_note('${unpaidId}', 'cancellation', 100, 'should not work', null)`
  );
  check("crediting an unpaid order is still refused", creditUnpaid !== null,
    creditUnpaid?.split("\n")[0]);

  // ══ D. The documented exception, stated rather than discovered ══
  console.log("\n=== D. the exception 0049 names ===");
  const creditedId = await newOrder({ paid: true, invoice: "WOV-TEST-0002" });
  await client.query(
    `select public.issue_credit_note($1, 'return', 1000, 'partial return', null)`, [creditedId]
  );
  await client.query(`update orders set status = 'cancelled' where id = $1`, [creditedId]);
  const { rows: partial } = await client.query(
    `select status from orders where id = $1`, [creditedId]
  );
  check(
    "a paid order with SOME credit note can still be cancelled by hand",
    partial[0].status === "cancelled",
    "documented in 0049: the check is that a credit document exists, not that it covers the total"
  );

  // ══ Nothing survives ══
  await client.query("rollback");
  const { rows: orders } = await client.query("select count(*)::int as n from orders");
  const { rows: notes } = await client.query("select count(*)::int as n from credit_notes");
  const { rows: trigger } = await client.query(
    `select count(*)::int as n from pg_trigger
      where tgname = 'orders_cancel_guard' and not tgisinternal`
  );
  console.log("\n=== after rollback ===");
  check("no order left behind", orders[0].n === baseline.orders,
    `${orders[0].n} rows, baseline ${baseline.orders}`);
  check("no credit note left behind", notes[0].n === baseline.notes,
    `${notes[0].n} rows, baseline ${baseline.notes}`);
  check("the guard is gone until the migration is applied", trigger[0].n === 0);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`\nthrew — rolled back, nothing written:\n  ${e.message}`);
  fail++;
} finally {
  await client.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

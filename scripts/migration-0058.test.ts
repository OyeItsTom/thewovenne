/**
 * Migration 0058 — settling twice must change nothing the second time.
 *
 * Two layers, and they are not the same kind of evidence:
 *
 *   STATIC   reads the migration file and checks its shape: the pre-flight
 *            refusal, the index predicates, the column, the table's posture,
 *            and that reserve_stock merges before it claims and claims before
 *            it decrements — with no check-then-act. Always runs.
 *
 *   DATABASE runs the migration, unmodified, on a real PostgreSQL engine
 *            (PGlite — Postgres compiled to WASM) over a fixture of the tables
 *            it touches, then exercises it: aggregation, the canonical NULL
 *            size, replay, the unique indexes, the pre-flight, and that a
 *            refused reservation leaves no claim behind. Runs when PGlite can
 *            be found (PGLITE_DIR, or node_modules); says SKIPPED otherwise.
 *
 * What neither layer proves: two sessions racing. PGlite is single-connection.
 * The concurrency argument is the unique index itself — a conflicting INSERT
 * waits for the in-flight transaction and then conflicts or proceeds — and
 * that is Postgres's guarantee, not this file's. Run:
 *
 *   PGLITE_DIR=<dir containing node_modules/@electric-sql/pglite> \
 *     npx tsx scripts/migration-0058.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

const FILE = path.join(__dirname, "../supabase/migrations/0058_settlement_is_idempotent.sql");
const sql = fs.readFileSync(FILE, "utf8");

// ══ STATIC ══════════════════════════════════════
console.log("\n=== STATIC: the migration's shape ===");
{
  const body = sql.slice(sql.indexOf("$fn$"), sql.lastIndexOf("$fn$"));

  check("pre-flight counts duplicate sale groups on the index's own expression",
    /select order_id, product_id, coalesce\(size_label, ''\) as lbl\s+from stock_movements\s+where reason = 'sale' and order_id is not null\s+group by 1, 2, 3 having count\(\*\) > 1/.test(sql), true);
  check("pre-flight counts duplicate redemptions per order",
    /select order_id from loyalty_ledger\s+where points < 0 and order_id is not null\s+group by 1 having count\(\*\) > 1/.test(sql), true);
  check("pre-flight raises rather than cleaning", /raise exception\s+'Cannot apply 0058/.test(sql), true);
  check("pre-flight runs before any object is created",
    sql.search(/^do \$\$/m) < sql.search(/^create unique index/m), true);

  check("sale index: one per (order, product, coalesced size), sale rows with an order only",
    /create unique index if not exists stock_movements_one_sale_per_line\s+on stock_movements \(order_id, product_id, coalesce\(size_label, ''\)\)\s+where reason = 'sale' and order_id is not null;/.test(sql), true);
  check("redemption index: one negative row per order",
    /create unique index if not exists loyalty_ledger_one_redemption_per_order\s+on loyalty_ledger \(order_id\) where points < 0 and order_id is not null;/.test(sql), true);
  check("confirmation_sent_at is a nullable timestamptz",
    /alter table orders\s+add column if not exists confirmation_sent_at timestamptz;/.test(sql), true);
  check("webhook table keyed on the event id",
    /create table if not exists razorpay_webhook_events \(\s+event_id\s+text primary key,\s+event_type\s+text,\s+received_at timestamptz not null default now\(\)\s+\);/.test(sql), true);
  check("webhook table: RLS on", sql.includes("alter table razorpay_webhook_events enable row level security;"), true);
  check("webhook table: anon/authenticated revoked", sql.includes("revoke all on razorpay_webhook_events from public, anon, authenticated;"), true);
  check("webhook table: service_role may insert", sql.includes("grant select, insert on razorpay_webhook_events to service_role;"), true);

  check("reserve_stock keeps its 0038 signature",
    sql.includes("create or replace function public.reserve_stock(p_items jsonb, p_order_id uuid default null)"), true);
  check("no drop/overload dance — same signature replaces in place", /drop function/.test(sql), false);
  check("security definer with a pinned search_path",
    /returns jsonb\s+language plpgsql\s+security definer\s+set search_path = public\s+as \$fn\$/.test(sql), true);
  check("execute revoked from anon/authenticated, granted to service_role",
    sql.includes("revoke execute on function public.reserve_stock(jsonb, uuid) from public, anon, authenticated;") &&
    sql.includes("grant execute on function public.reserve_stock(jsonb, uuid) to service_role;"), true);

  // Order of operations inside the function body.
  const iGroup = body.indexOf("group by e.product_id");
  const iInsert = body.indexOf("insert into stock_movements");
  const iUpdate = body.indexOf("update product_sizes");
  check("13. merges (group by) BEFORE it claims", iGroup > 0 && iGroup < iInsert, true);
  check("13. claims (insert) BEFORE it decrements", iInsert > 0 && iInsert < iUpdate, true);
  check("13. the claim is guarded by unique_violation, not by a prior SELECT",
    body.includes("exception when unique_violation then"), true);
  check("13. no check-then-act: nothing reads stock_movements before inserting",
    /select[^;]*from stock_movements/i.test(body), false);
  check("only a collision on the claim index counts as already reserved; anything else re-raises",
    /get stacked diagnostics conflict = constraint_name;\s+if conflict is distinct from 'stock_movements_one_sale_per_line' then\s+raise;/.test(body), true);
  check("sizeless identity is NULL: the label survives only when the product has sizes",
    body.includes("case when s.has_sizes then e.label end as size_label"), true);
  check("has_sizes is decided from product_sizes, not from the caller's label",
    /exists \(\s*select 1 from product_sizes ps where ps.product_id = e.product_id\s*\)/.test(body), true);
  check("labels are trimmed and blanks read as no label", body.includes("nullif(btrim(x ->> 'size'), '')"), true);
  check("quantities validated per line before merging", body.indexOf("Invalid quantity") < iGroup, true);
  check("a sized product with no label is refused, not sold out", body.includes("raise exception 'SIZE_REQUIRED:%'"), true);
  check("SOLD_OUT still raises (and so rolls the whole call back)", /raise exception 'SOLD_OUT:%:%'/.test(body) && /raise exception 'SOLD_OUT:%:'/.test(body), true);
  check("returns reserved + already_reserved", body.includes("jsonb_build_object('reserved', taken, 'already_reserved', skipped)"), true);

  check("no stale claim that the cart merges lines", /cart merges/i.test(sql), false);
  check("no tracking_status anywhere", /tracking_status/.test(sql), false);
  check("no PR-sequencing claims", /PR #|next PR|this PR/i.test(sql), false);
  check("verify block checks the overload count", sql.includes("as reserve_stock_overloads_must_be_1"), true);
}

// ══ DATABASE ════════════════════════════════════
type Row = Record<string, unknown>;
interface Db {
  query: (q: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  exec: (q: string) => Promise<unknown>;
}

function loadPGlite(): (new () => Db) | null {
  const require = createRequire(__filename);
  const candidates = [process.env.PGLITE_DIR, path.join(__dirname, "..")].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      const resolved = require.resolve("@electric-sql/pglite", { paths: [dir] });
      return (require(resolved) as { PGlite: new () => Db }).PGlite;
    } catch {
      /* try the next */
    }
  }
  return null;
}

const FIXTURE = `
  create role anon; create role authenticated; create role service_role;
  create table products (id uuid primary key default gen_random_uuid(), name text);
  create table product_versions (
    id uuid primary key default gen_random_uuid(),
    product_id uuid references products(id), state text not null,
    stock_quantity integer not null default 0);
  create table product_sizes (
    id uuid primary key default gen_random_uuid(),
    product_id uuid references products(id), label text not null,
    sort_order integer default 0, stock_quantity integer not null default 0);
  create table orders (
    id uuid primary key default gen_random_uuid(), razorpay_order_id text,
    payment_status text default 'pending', needs_review boolean not null default false, items jsonb);
  create table stock_movements (
    id uuid primary key default gen_random_uuid(),
    product_id uuid references products(id) on delete set null, size_label text,
    delta integer not null check (delta <> 0),
    reason text not null check (reason in ('sale','return','cancellation','correction','restock')),
    order_id uuid references orders(id) on delete set null, note text, actor_id uuid,
    created_at timestamptz not null default now());
  create table loyalty_ledger (
    id uuid primary key default gen_random_uuid(), user_id uuid not null, order_id uuid,
    points integer not null, reason text not null, created_at timestamptz not null default now());
  create unique index loyalty_ledger_one_award_per_order
    on loyalty_ledger (order_id) where points > 0 and order_id is not null;
`;

const SHIRT = "11111111-1111-1111-1111-111111111111";
const DHOTI = "22222222-2222-2222-2222-222222222222";
const O = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const U = "99999999-9999-9999-9999-999999999999";
const GHOST = "33333333-3333-3333-3333-333333333333";

async function seed(db: Db) {
  await db.exec(`
    insert into orders (id) select ('00000000-0000-0000-0000-00000000000' || n)::uuid from generate_series(1, 9) n;
    insert into products (id, name) values ('${SHIRT}', 'Shirt'), ('${DHOTI}', 'Dhoti');
    insert into product_versions (product_id, state, stock_quantity) values
      ('${SHIRT}', 'published', 99), ('${DHOTI}', 'published', 4), ('${DHOTI}', 'draft', 100);
    insert into product_sizes (product_id, label, stock_quantity) values
      ('${SHIRT}', 'S', 3), ('${SHIRT}', 'M', 5);
  `);
}

const reserve = async (db: Db, items: unknown[], order: string | null) => {
  const { rows } = await db.query("select public.reserve_stock($1::jsonb, $2::uuid) as r", [
    JSON.stringify(items),
    order,
  ]);
  return rows[0].r as { reserved: number; already_reserved: number };
};
const fails = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
const movements = async (db: Db, order: string) =>
  (await db.query(
    "select product_id, size_label, delta from stock_movements where order_id = $1 and reason = 'sale' order by product_id, size_label",
    [order]
  )).rows;
const sizeStock = async (db: Db, label: string) =>
  Number((await db.query("select stock_quantity from product_sizes where product_id = $1 and label = $2", [SHIRT, label])).rows[0].stock_quantity);
const dhotiStock = async (db: Db) =>
  Number((await db.query("select stock_quantity from product_versions where product_id = $1 and state = 'published'", [DHOTI])).rows[0].stock_quantity);

async function database() {
  const PGlite = loadPGlite();
  if (!PGlite) {
    console.log("\n=== DATABASE: SKIPPED — @electric-sql/pglite not found (set PGLITE_DIR) ===");
    skipped++;
    return;
  }

  const db = new PGlite();
  const v = (await db.query("select version()")).rows[0].version as string;
  console.log(`\n=== DATABASE: ${v.split(" ").slice(0, 2).join(" ")} (PGlite) ===`);
  await db.exec(FIXTURE);
  await seed(db);

  console.log("\n--- applying 0058 to a clean fixture ---");
  const applyError = await fails(() => db.exec(sql));
  check("the migration applies", applyError, "");
  {
    const { rows } = await db.query(`
      select
        (select count(*)::int from pg_indexes where indexname = 'stock_movements_one_sale_per_line') as sale_index,
        (select count(*)::int from pg_indexes where indexname = 'loyalty_ledger_one_redemption_per_order') as redemption_index,
        (select data_type || '/' || is_nullable from information_schema.columns where table_name = 'orders' and column_name = 'confirmation_sent_at') as confirmation,
        (select relrowsecurity from pg_class where oid = 'razorpay_webhook_events'::regclass) as rls,
        has_table_privilege('service_role', 'razorpay_webhook_events', 'INSERT') as svc_insert,
        has_table_privilege('anon', 'razorpay_webhook_events', 'SELECT') as anon_select,
        has_table_privilege('anon', 'razorpay_webhook_events', 'INSERT') as anon_insert,
        has_table_privilege('authenticated', 'razorpay_webhook_events', 'SELECT') as auth_select,
        has_table_privilege('authenticated', 'razorpay_webhook_events', 'INSERT') as auth_insert,
        has_function_privilege('authenticated', 'public.reserve_stock(jsonb, uuid)', 'EXECUTE') as auth_exec,
        has_function_privilege('service_role', 'public.reserve_stock(jsonb, uuid)', 'EXECUTE') as svc_exec,
        has_function_privilege('anon', 'public.reserve_stock(jsonb, uuid)', 'EXECUTE') as anon_exec,
        (select count(*)::int from pg_proc where proname = 'reserve_stock') as overloads`);
    const r = rows[0];
    check("sale index created", r.sale_index, 1);
    check("redemption index created", r.redemption_index, 1);
    check("9. confirmation_sent_at: timestamptz, nullable", r.confirmation, "timestamp with time zone/YES");
    check("webhook table: RLS enabled", r.rls, true);
    check("webhook table: service_role can insert", r.svc_insert, true);
    check("webhook table: anon cannot select", r.anon_select, false);
    check("webhook table: anon cannot insert", r.anon_insert, false);
    check("webhook table: authenticated cannot select", r.auth_select, false);
    check("webhook table: authenticated cannot insert", r.auth_insert, false);
    check("reserve_stock: authenticated may not execute", r.auth_exec, false);
    check("reserve_stock: service_role may execute", r.svc_exec, true);
    check("reserve_stock: anon may not", r.anon_exec, false);
    check("reserve_stock: exactly one overload", r.overloads, 1);
  }

  console.log("\n--- 1. duplicate sized input is one line ---");
  {
    const r = await reserve(db, [{ id: SHIRT, size: "M", quantity: 1 }, { id: SHIRT, size: "M", quantity: 2 }], O(1));
    check("reserved 3", r.reserved, 3);
    check("nothing already reserved", r.already_reserved, 0);
    check("one movement of -3", await movements(db, O(1)), [{ product_id: SHIRT, size_label: "M", delta: -3 }]);
    check("M stock 5 → 2", await sizeStock(db, "M"), 2);
  }

  console.log("\n--- 2 & 4. duplicate sizeless input, canonical NULL size ---");
  {
    const r = await reserve(db, [
      { id: DHOTI, size: "One Size", quantity: 1 },
      { id: DHOTI, size: "", quantity: 1 },
      { id: DHOTI, quantity: 1 },
    ], O(2));
    check("reserved 3 across three spellings of 'no size'", r.reserved, 3);
    check("one movement, size_label NULL", await movements(db, O(2)), [{ product_id: DHOTI, size_label: null, delta: -3 }]);
    check("published dhoti stock 4 → 1", await dhotiStock(db), 1);
    check("the draft version is untouched", Number((await db.query("select stock_quantity from product_versions where product_id = $1 and state = 'draft'", [DHOTI])).rows[0].stock_quantity), 100);
  }

  console.log("\n--- 3. different sizes stay independent ---");
  {
    const r = await reserve(db, [{ id: SHIRT, size: "S", quantity: 1 }, { id: SHIRT, size: " M ", quantity: 1 }], O(3));
    check("reserved 2", r.reserved, 2);
    check("two movements, S and M (trimmed)", await movements(db, O(3)), [
      { product_id: SHIRT, size_label: "M", delta: -1 },
      { product_id: SHIRT, size_label: "S", delta: -1 },
    ]);
    check("S 3 → 2", await sizeStock(db, "S"), 2);
    check("M 2 → 1", await sizeStock(db, "M"), 1);
  }

  console.log("\n--- 5. replaying an order ---");
  {
    const r = await reserve(db, [{ id: SHIRT, size: "M", quantity: 1 }, { id: SHIRT, size: "M", quantity: 2 }], O(1));
    check("second call reserves nothing", r.reserved, 0);
    check("reports 3 already reserved", r.already_reserved, 3);
    check("M stock unchanged", await sizeStock(db, "M"), 1);
    check("still one movement", (await movements(db, O(1))).length, 1);

    const again = await reserve(db, [{ id: DHOTI, size: "Free Size", quantity: 3 }], O(2));
    check("a sizeless replay under yet another label is still a replay", again.already_reserved, 3);
    check("dhoti stock unchanged", await dhotiStock(db), 1);

    const third = await reserve(db, [{ id: SHIRT, size: "M", quantity: 3 }], O(1));
    check("a third delivery is still a no-op", [third.reserved, third.already_reserved], [0, 3]);
  }

  console.log("\n--- 6. the index refuses a second sale row directly ---");
  {
    const dupM = await fails(() => db.query(
      "insert into stock_movements (product_id, size_label, delta, reason, order_id) values ($1, 'M', -1, 'sale', $2)", [SHIRT, O(1)]));
    check("duplicate (order, product, 'M') sale row refused", /stock_movements_one_sale_per_line/.test(dupM), true);
    const dupNull = await fails(() => db.query(
      "insert into stock_movements (product_id, size_label, delta, reason, order_id) values ($1, null, -1, 'sale', $2)", [DHOTI, O(2)]));
    check("duplicate (order, product, NULL) sale row refused — coalesce makes NULLs conflict", /stock_movements_one_sale_per_line/.test(dupNull), true);
    const cancel = await fails(() => db.query(
      "insert into stock_movements (product_id, size_label, delta, reason, order_id) values ($1, 'M', 3, 'cancellation', $2)", [SHIRT, O(1)]));
    check("a cancellation against the same order is still allowed", cancel, "");
    const noOrder = await fails(() => db.query(
      "insert into stock_movements (product_id, size_label, delta, reason) values ($1, 'M', -1, 'sale'), ($1, 'M', -1, 'sale')", [SHIRT]));
    check("sale rows with no order are outside the index", noOrder, "");
  }

  console.log("\n--- 7. a different order is a different sale ---");
  {
    const r = await reserve(db, [{ id: SHIRT, size: "M", quantity: 1 }], O(4));
    check("reserved 1 for the new order", [r.reserved, r.already_reserved], [1, 0]);
    check("M stock 1 → 0", await sizeStock(db, "M"), 0);
  }

  console.log("\n--- 12. insufficient stock leaves no claim behind ---");
  {
    // Dhoti has 1 left. Ask for 2.
    const err = await fails(() => reserve(db, [{ id: DHOTI, quantity: 2 }], O(5)));
    check("refused as SOLD_OUT", /SOLD_OUT:22222222/.test(err), true);
    check("no movement row for that order", await movements(db, O(5)), []);
    check("stock untouched", await dhotiStock(db), 1);
    await db.query("update product_versions set stock_quantity = 5 where product_id = $1 and state = 'published'", [DHOTI]);
    const retry = await reserve(db, [{ id: DHOTI, quantity: 2 }], O(5));
    check("after a restock the retry is a FIRST reservation, not a replay", [retry.reserved, retry.already_reserved], [2, 0]);
    check("stock 5 → 3", await dhotiStock(db), 3);

    // Multi-line: the first line fits, the second does not. Nothing may stick.
    const sBefore = await sizeStock(db, "S");
    const multi = await fails(() => reserve(db, [{ id: SHIRT, size: "S", quantity: 1 }, { id: DHOTI, quantity: 99 }], O(6)));
    check("a short line aborts the whole call", /SOLD_OUT/.test(multi), true);
    check("the line that fitted was rolled back too — no rows for the order", await movements(db, O(6)), []);
    check("its stock is untouched", await sizeStock(db, "S"), sBefore);
  }

  console.log("\n--- input validation ---");
  {
    check("zero quantity refused", /Invalid quantity/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "S", quantity: 0 }], O(7)))), true);
    check("a negative cannot net off a positive", /Invalid quantity/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "S", quantity: 2 }, { id: SHIRT, size: "S", quantity: -1 }], O(7)))), true);
    check("a sized product with no size is SIZE_REQUIRED", /SIZE_REQUIRED:11111111/.test(await fails(() => reserve(db, [{ id: SHIRT, quantity: 1 }], O(7)))), true);
    check("an unknown size is SOLD_OUT (exact label match, as before)", /SOLD_OUT:11111111.*:XL/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "XL", quantity: 1 }], O(7)))), true);
    check("not an array is refused", /expects a JSON array/.test(await fails(() => reserve(db, { id: SHIRT } as unknown as unknown[], O(7)))), true);
    check("JSON null is refused", /expects a JSON array/.test(await fails(() => reserve(db, null as unknown as unknown[], O(7)))), true);
    check("H. a fractional quantity is rejected, not truncated", /invalid input syntax for type integer/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "S", quantity: 1.5 }], O(7)))), true);
    check("I. a non-numeric quantity fails", /invalid input syntax for type integer/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "S", quantity: "two" }], O(7)))), true);
    check("   a missing quantity fails", /Invalid quantity/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "S" }], O(7)))), true);
    check("J. a valid line does not mask a malformed twin", /Invalid quantity/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "S", quantity: 2 }, { id: SHIRT, size: "S", quantity: 0 }], O(7)))), true);
    check("   a malformed id fails", /invalid input syntax for type uuid/.test(await fails(() => reserve(db, [{ id: "nope", quantity: 1 }], O(7)))), true);
    check("   a product that does not exist fails on the foreign key, not as sizeless stock", /violates foreign key constraint/.test(await fails(() => reserve(db, [{ id: GHOST, quantity: 1 }], O(7)))), true);
    check("   an order that does not exist fails on the foreign key", /violates foreign key constraint/.test(await fails(() => reserve(db, [{ id: SHIRT, size: "S", quantity: 1 }], "00000000-0000-0000-0000-0000000000ff"))), true);
    check("L. an empty array reserves nothing and does not fail (as 0038)", await reserve(db, [], O(7)), { reserved: 0, already_reserved: 0 });
    check("nothing stuck from any of those", await movements(db, O(7)), []);
    // A different unique constraint colliding on the same INSERT must NOT read
    // as "already reserved". Contrived on purpose: a temporary index nothing
    // in production has, so the only thing it can prove is the narrowing.
    await db.exec("create unique index tmp_other_unique on stock_movements (order_id) where reason = 'sale' and delta = -7");
    await db.query("update product_sizes set stock_quantity = 20 where product_id = $1", [SHIRT]);
    check("   (setup) the first 7 of S reserve normally", (await reserve(db, [{ id: SHIRT, size: "S", quantity: 7 }], O(8))).reserved, 7);
    const other = await fails(() => reserve(db, [{ id: SHIRT, size: "M", quantity: 7 }], O(8)));
    check("G. a collision on some OTHER unique constraint re-raises instead of skipping", /tmp_other_unique/.test(other), true);
    check("   and it is not counted as already reserved", await movements(db, O(8)), [{ product_id: SHIRT, size_label: "S", delta: -7 }]);
    await db.exec("drop index tmp_other_unique");
    // Without an order id there is no claim and no idempotency — as documented.
    await db.query("update product_sizes set stock_quantity = 10 where product_id = $1 and label = 'S'", [SHIRT]);
    await reserve(db, [{ id: SHIRT, size: "S", quantity: 1 }], null);
    await reserve(db, [{ id: SHIRT, size: "S", quantity: 1 }], null);
    check("M. with no order id every call decrements (documented, unchanged from 0038)", await sizeStock(db, "S"), 8);
  }

  console.log("\n--- 8. loyalty redemption is one per order ---");
  {
    check("first redemption", await fails(() => db.query("insert into loyalty_ledger (user_id, order_id, points, reason) values ($1, $2, -10, 'r')", [U, O(1)])), "");
    check("second redemption for the same order refused", /loyalty_ledger_one_redemption_per_order/.test(await fails(() => db.query("insert into loyalty_ledger (user_id, order_id, points, reason) values ($1, $2, -5, 'r')", [U, O(1)]))), true);
    check("an award on the same order is fine", await fails(() => db.query("insert into loyalty_ledger (user_id, order_id, points, reason) values ($1, $2, 10, 'a')", [U, O(1)])), "");
    check("a redemption on another order is fine", await fails(() => db.query("insert into loyalty_ledger (user_id, order_id, points, reason) values ($1, $2, -10, 'r')", [U, O(2)])), "");
    check("adjustments with no order are outside the index", await fails(() => db.query("insert into loyalty_ledger (user_id, points, reason) values ($1, -1, 'x'), ($1, -1, 'x')", [U])), "");
  }

  console.log("\n--- 10. webhook events are one per id ---");
  {
    check("first delivery recorded", await fails(() => db.query("insert into razorpay_webhook_events (event_id, event_type) values ('evt_1', 'payment.captured')")), "");
    check("redelivery refused by the primary key", /razorpay_webhook_events_pkey/.test(await fails(() => db.query("insert into razorpay_webhook_events (event_id, event_type) values ('evt_1', 'payment.captured')"))), true);
  }

  console.log("\n--- 11. the pre-flight refuses dirty data ---");
  for (const [label, dirty, expect] of [
    ["duplicate sale lines", `insert into stock_movements (product_id, size_label, delta, reason, order_id) values ('${SHIRT}', 'M', -1, 'sale', '${O(1)}'), ('${SHIRT}', 'M', -1, 'sale', '${O(1)}')`, /1 duplicated sale line\(s\) and 0 duplicated redemption/],
    ["duplicate NULL-size sale lines", `insert into stock_movements (product_id, size_label, delta, reason, order_id) values ('${DHOTI}', null, -1, 'sale', '${O(1)}'), ('${DHOTI}', null, -1, 'sale', '${O(1)}')`, /1 duplicated sale line/],
    ["duplicate redemptions", `insert into loyalty_ledger (user_id, order_id, points, reason) values ('${U}', '${O(1)}', -1, 'r'), ('${U}', '${O(1)}', -1, 'r')`, /0 duplicated sale line\(s\) and 1 duplicated redemption/],
  ] as const) {
    const dirtyDb = new PGlite();
    await dirtyDb.exec(FIXTURE);
    await seed(dirtyDb);
    await dirtyDb.exec(dirty);
    const err = await fails(() => dirtyDb.exec(sql));
    check(`${label}: refused`, expect.test(err), true, err.slice(0, 80));
    const { rows } = await dirtyDb.query("select to_regclass('public.razorpay_webhook_events') is not null as created");
    check(`${label}: and nothing was created`, rows[0].created, false);
  }

  console.log("\n--- re-applying is a no-op ---");
  {
    check("running 0058 twice does not fail", await fails(() => db.exec(sql)), "", "every object is `if not exists` / `or replace`");
    check("still one reserve_stock", Number((await db.query("select count(*)::int as n from pg_proc where proname = 'reserve_stock'")).rows[0].n), 1);
  }
}

void (async () => {
  await database();
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} section skipped` : ""}`);
  process.exit(fail > 0 ? 1 : 0);
})();

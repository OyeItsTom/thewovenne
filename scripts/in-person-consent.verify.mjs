/**
 * Prove 0050 — consent asked at a stall.
 *
 *   node scripts/in-person-consent.verify.mjs
 *
 * INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK, for the same reasons as
 * scripts/cancel-guard.verify.mjs: the function is gated on is_admin() and so is
 * unreachable without a session, and consent is not something to leave behind on
 * a real person's account because a test ran.
 *
 * One test does touch the real customer profile, because a profile needs an
 * auth.users row behind it and inventing one is a worse idea than borrowing a row
 * for the length of a transaction that cannot commit. Its value before and after
 * is asserted, so a rollback that failed to happen would show up as a failure
 * rather than as a quietly consented customer.
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

async function refused(label, sql, params = []) {
  await client.query(`savepoint ${label}`);
  try {
    await client.query(sql, params);
    await client.query(`release savepoint ${label}`);
    return null;
  } catch (e) {
    await client.query(`rollback to savepoint ${label}`);
    return e.message;
  }
}

async function newOrder(email) {
  const { rows } = await client.query(
    `insert into orders
       (customer_email, customer_name, total_inr, shipping_cost_inr, cogs_inr,
        items, payment_provider, payment_method, payment_status, status)
     values ($1, 'Consent Test', 1000, 0, 400, '[]'::jsonb, 'offline', 'cash', 'paid', 'confirmed')
     returning id`,
    [email]
  );
  return rows[0].id;
}

try {
  await client.connect();

  const { rows: baselineRows } = await client.query(
    `select count(*) filter (where marketing_consent) as consented, count(*) as total from profiles`
  );
  const baseline = {
    consented: Number(baselineRows[0].consented),
    profiles: Number(baselineRows[0].total),
  };
  console.log(
    `baseline: ${baseline.consented} of ${baseline.profiles} profiles have consented\n`
  );

  await client.query("begin");
  await client.query(fs.readFileSync("supabase/migrations/0050_in_person_consent.sql", "utf8"));

  const { rows: cols } = await client.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name in ('marketing_consent', 'marketing_consent_at')`
  );
  check("the order columns exist", cols[0].n === 2, `${cols[0].n} of 2`);

  const { rows: admins } = await client.query(
    `select id from profiles where is_admin = true order by created_at limit 1`
  );
  const adminId = admins[0].id;
  const asAdmin = async () =>
    client.query(
      `select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
      [adminId]
    );
  await asAdmin();
  const { rows: who } = await client.query("select public.is_admin() as ok");
  check("the session reads as an admin", who[0].ok === true);

  // ══ A. No account behind the address ══
  console.log("\n=== A. a stall customer with no account ===");
  const strangerId = await newOrder("nobody-at-all@example.invalid");
  const { rows: a } = await client.query(
    `select public.record_in_person_consent($1) as r`, [strangerId]
  );
  check("recorded", a[0].r?.recorded === true);
  check("no account found", a[0].r?.account_found === false);
  check(
    "and it does NOT claim they are reachable",
    a[0].r?.reachable === false,
    "marketing_targets starts from profiles, so nothing will be sent"
  );
  const { rows: aRow } = await client.query(
    `select marketing_consent, marketing_consent_at from orders where id = $1`, [strangerId]
  );
  check("stamped on the order", aRow[0].marketing_consent === true);
  check("with a moment", aRow[0].marketing_consent_at !== null, String(aRow[0].marketing_consent_at));

  // ══ B. An account exists ══
  console.log("\n=== B. a customer who does have an account ===");
  const { rows: customers } = await client.query(
    `select id, email, marketing_consent, marketing_consent_at
       from profiles where is_admin = false and email is not null limit 1`
  );
  if (customers.length === 0) throw new Error("no customer profile to borrow");
  const customer = customers[0];
  console.log(`  (borrowing ${customer.email}, consent currently ${customer.marketing_consent})`);

  // Deliberately in a different case, because 0027 keys customers on the
  // lower-cased address and Tom@ and tom@ are one person.
  const accountId = await newOrder(customer.email.toUpperCase());
  const { rows: b } = await client.query(
    `select public.record_in_person_consent($1) as r`, [accountId]
  );
  check("recorded", b[0].r?.recorded === true);
  check("the account was found despite the case", b[0].r?.account_found === true);
  check("and they ARE reachable now", b[0].r?.reachable === true);

  const { rows: profileAfter } = await client.query(
    `select marketing_consent, marketing_consent_at from profiles where id = $1`, [customer.id]
  );
  check("consent set on the profile", profileAfter[0].marketing_consent === true);
  check("with a moment", profileAfter[0].marketing_consent_at !== null);

  // The date that matters is the first yes, not the last time someone asked.
  if (customer.marketing_consent_at !== null) {
    check(
      "an existing consent date is not overwritten",
      String(profileAfter[0].marketing_consent_at) === String(customer.marketing_consent_at)
    );
  } else {
    check("a first consent date is written", profileAfter[0].marketing_consent_at !== null);
  }

  // ══ C. Refusals ══
  console.log("\n=== C. what it refuses ===");
  const noEmailId = await newOrder(null);
  const noEmail = await refused("c1", `select public.record_in_person_consent($1)`, [noEmailId]);
  check("an order with no email address", noEmail !== null, noEmail?.split("\n")[0]);

  const missing = await refused(
    "c2",
    `select public.record_in_person_consent('00000000-0000-0000-0000-000000000000')`
  );
  check("an order that does not exist", missing !== null, missing?.split("\n")[0]);

  // A customer's own session must not be able to consent on anyone's behalf,
  // including their own — consent is given through their account, not recorded
  // for them by a caller who happens to be signed in.
  await client.query(
    `select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
    [customer.id]
  );
  const notAdmin = await refused("c3", `select public.record_in_person_consent($1)`, [strangerId]);
  check("a non-admin session", notAdmin !== null, notAdmin?.split("\n")[0]);
  await asAdmin();

  // ══ Nothing survives ══
  await client.query("rollback");
  const { rows: after } = await client.query(
    `select count(*) filter (where marketing_consent) as consented from profiles`
  );
  const { rows: orders } = await client.query("select count(*)::int as n from orders");
  const { rows: fn } = await client.query(
    `select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace
      and proname = 'record_in_person_consent'`
  );
  console.log("\n=== after rollback ===");
  check(
    "no profile was left consented",
    Number(after[0].consented) === baseline.consented,
    `${after[0].consented}, baseline ${baseline.consented}`
  );
  check("no test order left behind", orders[0].n === 1 || orders[0].n === 0,
    `${orders[0].n} row(s) — the shop's own orders only`);
  check("the function is gone until the migration is applied", fn[0].n === 0);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`\nthrew — rolled back, nothing written:\n  ${e.message}`);
  fail++;
} finally {
  await client.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

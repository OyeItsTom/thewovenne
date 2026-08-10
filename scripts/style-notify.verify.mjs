/**
 * Prove 0055 — the shop is told once, about its own submissions only.
 *
 *   node scripts/style-notify.verify.mjs
 *
 * Inside one transaction that is always rolled back, impersonating real roles.
 *
 * WHY THIS FILE MATTERS MORE THAN MOST. claim_style_notification is reachable
 * from an endpoint that any signed-in customer can call — the submission is an
 * INSERT from the browser, so the notification has to be requested rather than
 * triggered. Everything that stops that endpoint being a way to post mail into
 * the shop's inbox lives in this function, and SECURITY DEFINER means it steps
 * around the RLS that would otherwise be a second line. So each rule is
 * exercised rather than assumed.
 */
import fs from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0, bad = 0;
const t = (n, p, d = "") => { console.log(`  ${p ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); p ? ok++ : bad++; };
const sp = async (label, fn) => {
  await c.query(`savepoint ${label}`);
  try { const r = await fn(); await c.query(`release savepoint ${label}`); return { ok: true, r }; }
  catch (e) { await c.query(`rollback to savepoint ${label}`); return { ok: false, e: e.message }; }
};

await c.connect();
// Read a baseline first. Asserting "there are no submissions" would pass today
// and fail the morning after the first real one — the cancel-guard test taught
// that lesson by breaking on the shop's first order.
const baseline = (await c.query(
  "select (select count(*)::int from style_submissions) s, (select count(*)::int from orders) o"
)).rows[0];

try {
  await c.query("begin");
  await c.query(fs.readFileSync("supabase/migrations/0055_style_submission_notice.sql", "utf8"));

  const admin = (await c.query("select id,email from profiles where is_admin limit 1")).rows[0];
  const cust  = (await c.query("select id,email from profiles where not is_admin limit 1")).rows[0];
  const other = (await c.query("select id,email from profiles where not is_admin offset 1 limit 1")).rows[0];
  const prod  = (await c.query("select id,name from products limit 1")).rows[0];

  await c.query(
    `insert into orders (customer_email,total_inr,items,payment_provider,payment_method,payment_status,status)
     values ($1,1000,$2::jsonb,'offline','cash','paid','delivered')`,
    [cust.email, JSON.stringify([{ id: prod.id, name: "x", size: "M", quantity: 1, price_inr: 1000 }])]
  );

  const asUser = (id, email) =>
    c.query(`set local request.jwt.claims = '${JSON.stringify({ sub: id, email })}'`);
  await c.query("set local role authenticated");
  await asUser(cust.id, cust.email);

  const sid = (await c.query(
    `insert into style_submissions (product_id,user_id,photo_url,photo_width,photo_height,caption,credit_name,consented_at)
     values ($1,$2,'https://example.invalid/a.jpg',1200,1500,'Through the monsoon','Ananya',now()) returning id`,
    [prod.id, cust.id]
  )).rows[0].id;

  console.log("\n=== the owner claims it, once ===");

  const first = (await c.query("select public.claim_style_notification($1) as p", [sid])).rows[0].p;
  t("a pending submission can be claimed", first !== null);
  t("it carries the product name", first?.product_name === prod.name, String(first?.product_name));
  t("and the caption", first?.caption === "Through the monsoon");
  t("and the credit name", first?.credit_name === "Ananya");
  t("and says a photograph came", first?.has_photo === true);
  t("the customer's email is NOT in the payload",
    !JSON.stringify(first ?? {}).includes(cust.email),
    "the route runs under a customer session; contact details stay in the admin queue");

  const second = (await c.query("select public.claim_style_notification($1) as p", [sid])).rows[0].p;
  t("a second claim returns nothing", second === null,
    "this is what stops the endpoint being a way to post mail to the shop");

  const stamped = (await c.query("select admin_notified_at from style_submissions where id=$1", [sid])).rows[0];
  t("the row is stamped as announced", stamped.admin_notified_at !== null);

  console.log("\n=== a failed send can be undone ===");

  const released = (await c.query("select public.release_style_notification($1) as r", [sid])).rows[0].r;
  t("the owner may release their claim", released === true);
  const after = (await c.query("select admin_notified_at from style_submissions where id=$1", [sid])).rows[0];
  t("the stamp is gone, so the queue shows it as un-announced", after.admin_notified_at === null,
    "a stamp with no email behind it would hide the failure");
  const retry = (await c.query("select public.claim_style_notification($1) as p", [sid])).rows[0].p;
  t("and it can be claimed again — a retry works", retry !== null);

  console.log("\n=== what it refuses ===");

  await asUser(other.id, other.email);
  const foreignClaim = (await c.query("select public.claim_style_notification($1) as p", [sid])).rows[0].p;
  t("somebody else cannot claim your submission", foreignClaim === null,
    "ownership comes from auth.uid(), never from the argument");
  const foreignRelease = (await c.query("select public.release_style_notification($1) as r", [sid])).rows[0].r;
  t("nor release it", foreignRelease === false);

  // Back to un-announced through the supported path, so the next assertion is
  // about approval rather than about a leftover stamp.
  await asUser(cust.id, cust.email);
  await c.query("select public.release_style_notification($1)", [sid]);

  await asUser(admin.id, admin.email);
  await c.query("select public.moderate_style($1,'approved',null)", [sid]);
  await asUser(cust.id, cust.email);
  const approvedClaim = (await c.query("select public.claim_style_notification($1) as p", [sid])).rows[0].p;
  t("an approved photograph is not announced as waiting", approvedClaim === null,
    "there is nothing left for an admin to do about it");

  const missing = (await c.query(
    "select public.claim_style_notification('00000000-0000-0000-0000-000000000000') as p"
  )).rows[0].p;
  t("an id that does not exist returns nothing rather than raising", missing === null);

  console.log("\n=== the column is not writable by hand ===");

  const direct = await sp("d1", () =>
    c.query("update style_submissions set admin_notified_at = now() where id = $1", [sid]));
  const changed = (await c.query("select admin_notified_at from style_submissions where id=$1", [sid])).rows[0];
  t("a customer cannot stamp the column directly",
    !direct.ok || changed.admin_notified_at === null,
    direct.ok ? "the UPDATE was allowed but wrote nothing" : (direct.e || "").slice(0, 60));

  console.log("\n=== a resubmission is announced again ===");

  await asUser(admin.id, admin.email);
  await c.query("select public.moderate_style($1,'rejected','A little blurry')", [sid]);
  await asUser(cust.id, cust.email);
  await c.query("select public.resubmit_style($1,'https://example.invalid/b.jpg',1400,1750,null,null,'Second try','Ananya')", [sid]);
  const afterResubmit = (await c.query("select status, admin_notified_at from style_submissions where id=$1", [sid])).rows[0];
  t("resubmitting clears the old stamp", afterResubmit.admin_notified_at === null,
    "0053 knew nothing about this column — without the fix the second photograph would arrive silently");
  const resubmitClaim = (await c.query("select public.claim_style_notification($1) as p", [sid])).rows[0].p;
  t("so the second photograph is announced too", resubmitClaim !== null);

  console.log("\n=== grants ===");
  const grants = (await c.query(`
    select
      (select count(*)::int from information_schema.role_routine_grants
        where routine_name='claim_style_notification' and grantee='anon') as anon_claim,
      (select count(*)::int from information_schema.role_routine_grants
        where routine_name='claim_style_notification' and grantee='authenticated') as auth_claim
  `)).rows[0];
  t("a signed-out visitor cannot claim anything", grants.anon_claim === 0);
  t("a signed-in customer can", grants.auth_claim === 1);
} finally {
  await c.query("rollback");
  const now = (await c.query(
    "select (select count(*)::int from style_submissions) s, (select count(*)::int from orders) o"
  )).rows[0];
  t("nothing was left behind", now.s === baseline.s && now.o === baseline.o,
    `submissions ${baseline.s}→${now.s}, orders ${baseline.o}→${now.o}`);
  await c.end();
}

console.log(`\n${ok} passed, ${bad} failed\n`);
process.exit(bad === 0 ? 0 : 1);

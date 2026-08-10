/**
 * Prove 0053 — a customer may send another photograph, and only their own.
 *
 *   node scripts/style-resubmit.verify.mjs
 *
 * Inside one transaction that is always rolled back, impersonating real roles.
 * resubmit_style is SECURITY DEFINER, which means it steps around the RLS that
 * protects everything else here — so every rule it is supposed to enforce has to
 * be exercised rather than assumed. That is the whole point of this file.
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
const baseline = (await c.query("select (select count(*)::int from style_submissions) s,(select count(*)::int from orders) o")).rows[0];

try {
  await c.query("begin");
  await c.query(fs.readFileSync("supabase/migrations/0053_style_resubmission.sql", "utf8"));

  const admin = (await c.query("select id,email from profiles where is_admin limit 1")).rows[0];
  const cust  = (await c.query("select id,email from profiles where not is_admin limit 1")).rows[0];
  const other = (await c.query("select id,email from profiles where not is_admin offset 1 limit 1")).rows[0];
  const prod  = (await c.query("select id,name from products limit 1")).rows[0];

  // A delivered, paid order so has_purchased() is true for the customer only.
  await c.query(`insert into orders (customer_email,total_inr,items,payment_provider,payment_method,payment_status,status)
    values ($1,1000,$2::jsonb,'offline','cash','paid','delivered')`,
    [cust.email, JSON.stringify([{ id: prod.id, name: "x", size: "M", quantity: 1, price_inr: 1000 }])]);

  const asUser = (id, email) => c.query(`set local request.jwt.claims = '${JSON.stringify({ sub: id, email })}'`);
  await c.query("set local role authenticated");
  await asUser(cust.id, cust.email);

  const sid = (await c.query(
    `insert into style_submissions (product_id,user_id,photo_url,photo_width,photo_height,consented_at)
     values ($1,$2,'https://example.invalid/first.jpg',1200,1500,now()) returning id`,
    [prod.id, cust.id]
  )).rows[0].id;

  console.log("\n=== a rejected submission can be replaced ===");
  await asUser(admin.id, admin.email);
  await c.query(`select public.moderate_style($1,'rejected','A little blurry')`, [sid]);
  await asUser(cust.id, cust.email);

  const again = await sp("r1", () => c.query(
    `select public.resubmit_style($1,'https://example.invalid/second.jpg',1400,1750,null,null,'Second try','Ananya')`, [sid]));
  t("the customer may send another", again.ok, (again.e || "").slice(0, 70));

  const row = (await c.query(`select * from style_submissions where id=$1`, [sid])).rows[0];
  t("the new photograph replaced the old", row.photo_url.endsWith("second.jpg"), row.photo_url);
  t("it is pending again, so an admin sees it", row.status === "pending");
  t("the old rejection reason is gone", row.reject_reason === null,
    "a reason belonging to a photograph nobody can see would be worse than none");
  t("the review stamps are cleared", row.reviewed_at === null && row.reviewed_by === null);
  t("consent was recorded again, not carried over", row.consented_at !== null,
    "the old consent was for a different photograph");
  t("dimensions came with it", row.photo_width === 1400 && row.photo_height === 1750);

  console.log("\n=== what it refuses ===");
  const empty = await sp("r2", () => c.query(`select public.resubmit_style($1,null,null,null,null,null,'nothing',null)`, [sid]));
  t("a resubmission with neither photo nor link", !empty.ok, (empty.e || "").slice(0, 60));

  await asUser(other.id, other.email);
  const notMine = await sp("r3", () => c.query(
    `select public.resubmit_style($1,'https://example.invalid/theirs.jpg',900,1200,null,null,null,null)`, [sid]));
  t("somebody else's submission", !notMine.ok, (notMine.e || "").slice(0, 60));
  // Read it back AS ITS OWNER. Reading while still impersonating the other
  // customer returns no rows at all — 0047's select policy scopes the table to
  // your own submissions — which is RLS working, and would make this assertion
  // pass for the wrong reason if it tolerated an empty result.
  await asUser(cust.id, cust.email);
  const untouched = (await c.query(`select photo_url from style_submissions where id=$1`, [sid])).rows[0];
  t("and it is left exactly as it was", untouched?.photo_url?.endsWith("second.jpg") === true,
    untouched?.photo_url ?? "no row visible");

  console.log("\n=== an approved photograph is not editable ===");
  await asUser(admin.id, admin.email);
  await c.query(`select public.moderate_style($1,'approved')`, [sid]);
  await asUser(cust.id, cust.email);
  const swap = await sp("r4", () => c.query(
    `select public.resubmit_style($1,'https://example.invalid/swapped.jpg',1200,1500,null,null,null,null)`, [sid]));
  t("the published photograph cannot be swapped", !swap.ok, (swap.e || "").slice(0, 70));
  t("which is the whole moderation model holding",
    (await c.query(`select photo_url from style_submissions where id=$1`, [sid])).rows[0].photo_url.endsWith("second.jpg"));

  console.log("\n=== withdrawal is not a route back in ===");
  // The customer withdraws (the one content column they may write), then an
  // ADMIN moves it out of 'approved' — a customer cannot write status at all,
  // and the previous version of this test tried to, which raised and aborted the
  // whole transaction. .catch() hid that from JavaScript while Postgres refused
  // every statement after it. Anything expected to fail goes through sp().
  await c.query(`update style_submissions set withdrawn_at=now() where id=$1`, [sid]);
  await asUser(admin.id, admin.email);
  await c.query(`select public.moderate_style($1,'rejected','withdrawn by the customer')`, [sid]);
  await asUser(cust.id, cust.email);
  const afterWithdraw = await sp("r5", () => c.query(
    `select public.resubmit_style($1,'https://example.invalid/back.jpg',1200,1500,null,null,null,null)`, [sid]));
  t("a withdrawn submission is not resubmitted, it is replaced", !afterWithdraw.ok,
    (afterWithdraw.e || "").slice(0, 60));

  console.log("\n=== the column grant is unchanged ===");
  const cols = (await c.query(`select column_name from information_schema.column_privileges
    where table_name='style_submissions' and grantee='authenticated' and privilege_type='UPDATE'
    order by column_name`)).rows.map((r) => r.column_name);
  t("a customer still cannot write the content columns directly",
    JSON.stringify(cols) === JSON.stringify(["rejection_emailed_at", "withdrawn_at"]), cols.join(", "));
} catch (e) {
  console.log("  ERROR:", e.message); bad++;
} finally {
  await c.query("rollback").catch(() => {});
  const left = (await c.query("select (select count(*)::int from style_submissions) s,(select count(*)::int from orders) o")).rows[0];
  t("ROLLED BACK — nothing written",
    left.s === baseline.s && left.o === baseline.o,
    `submissions ${left.s}/${baseline.s}, orders ${left.o}/${baseline.o}`);
  await c.end();
  console.log(`\n${ok} passed, ${bad} failed\n`);
  process.exit(bad ? 1 : 0);
}

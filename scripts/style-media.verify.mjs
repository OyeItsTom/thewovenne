/**
 * Prove 0052 — somewhere to put photographs, and permission to say why.
 *
 *   node scripts/style-media.verify.mjs
 *
 * INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK, with the migration applied
 * inside it, so the rules are exercised against the real database before being
 * added to it.
 *
 * THE CONSTRAINTS ARE EXERCISED, NOT INSPECTED, and that is not ceremony: the
 * first version of style_dimensions_together read correctly and did nothing. With
 * a width and no height the first branch was false and the second `true and null`
 * = null, and a CHECK passes on null because it only refuses FALSE — so half a
 * pair of dimensions went straight in. Same three-valued trap that took every
 * non-form signup down in 0026. Reading the constraint would not have found it.
 */
import fs from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
const sql = fs.readFileSync("supabase/migrations/0052_style_media_and_feedback.sql", "utf8");

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

await client.connect();

// What the database held before this run. Compared against after the rollback,
// rather than against zero: once 0052 is applied for real the bucket survives,
// and "the bucket is gone" would then fail forever on a migration that works.
const baseline = {
  submissions: (await client.query(`select count(*)::int as n from style_submissions`)).rows[0].n,
  bucket: (await client.query(`select count(*)::int as n from storage.buckets where id = 'style-photos'`)).rows[0].n,
};
console.log(`baseline: ${baseline.submissions} submission(s), 0052 ${baseline.bucket ? "already applied" : "not yet applied"}`);
/** Run something expected to fail; a raise aborts a transaction without one. */
const refused = async (label, fn) => {
  await client.query(`savepoint ${label}`);
  try { await fn(); await client.query(`release savepoint ${label}`); return null; }
  catch (e) { await client.query(`rollback to savepoint ${label}`); return e.message; }
};

try {
  await client.query("begin");
  await client.query(sql);

  console.log("\n=== what the migration says it did ===");
  const v = (await client.query(sql.split("-- ── Verify ────────────────────────────────────")[1])).rows[0];
  t("the style-photos bucket exists", v.bucket === "1");
  t("three storage policies: public read, own-folder write, admin delete", v.storage_policies === "3");
  t("three columns added", v.new_columns === "3");
  t("both checks added", v.new_checks === "2");
  t("the public view carries the dimensions", v.view_carries_dimensions === "2");
  t("moderate_style resets the notification stamp", v.moderate_resets_notification === "1");
  t("a customer may write exactly two columns", v.customer_updatable_columns === "2",
    "withdrawn_at and rejection_emailed_at, nothing else");

  const [admin] = (await client.query(`select id from profiles where is_admin order by created_at limit 1`)).rows;
  await client.query(
    `select set_config('request.jwt.claims', json_build_object('sub',$1::text,'role','authenticated')::text, true)`,
    [admin.id]
  );
  const [product] = (await client.query(`select id from products limit 1`)).rows;
  const [customer] = (await client.query(`select id from profiles where not is_admin limit 1`)).rows;

  console.log("\n=== dimensions come in pairs or not at all ===");
  const id = (await client.query(
    `insert into style_submissions (product_id, user_id, photo_url, consented_at, photo_width, photo_height)
     values ($1, $2, 'https://example.invalid/y.jpg', now(), 1200, 1500) returning id`,
    [product.id, customer.id]
  )).rows[0].id;
  t("a photo with both dimensions is accepted", true);
  t("width without height is refused",
    (await refused("d1", () => client.query(`update style_submissions set photo_height = null where id = $1`, [id]))) !== null,
    "the bug the first version of this constraint had");
  t("height without width is refused",
    (await refused("d2", () => client.query(`update style_submissions set photo_width = null where id = $1`, [id]))) !== null);
  t("both null is accepted — a video-only submission",
    (await refused("d3", () => client.query(`update style_submissions set photo_width = null, photo_height = null where id = $1`, [id]))) === null);
  await client.query(`update style_submissions set photo_width = 1200, photo_height = 1500 where id = $1`, [id]);
  t("a nonsense dimension is refused",
    (await refused("d4", () => client.query(`update style_submissions set photo_width = 999999 where id = $1`, [id]))) !== null);

  console.log("\n=== a customer is only told about a real, reasoned rejection ===");
  t("telling them about a PENDING submission is refused",
    (await refused("d5", () => client.query(`update style_submissions set rejection_emailed_at = now() where id = $1`, [id]))) !== null);
  await client.query(`select public.moderate_style($1, 'rejected', 'The photo is a little blurry')`, [id]);
  t("after a reasoned rejection it is allowed",
    (await refused("d6", () => client.query(`update style_submissions set rejection_emailed_at = now() where id = $1`, [id]))) === null);
  await client.query(`select public.moderate_style($1, 'rejected', 'A different reason')`, [id]);
  t("a second rejection clears the stamp, so the new reason can be sent",
    (await client.query(`select rejection_emailed_at from style_submissions where id = $1`, [id])).rows[0].rejection_emailed_at === null);

  console.log("\n=== silent rejection, which is what spam gets ===");
  await client.query(`select public.moderate_style($1, 'rejected', null)`, [id]);
  t("no reason is kept", (await client.query(`select reject_reason from style_submissions where id = $1`, [id])).rows[0].reject_reason === null);
  t("and nothing can be emailed about it",
    (await refused("d7", () => client.query(`update style_submissions set rejection_emailed_at = now() where id = $1`, [id]))) !== null);

  await client.query("rollback");
  console.log("\n=== after rollback ===");
  t("nothing was left behind",
    (await client.query(`select count(*)::int as n from style_submissions`)).rows[0].n === baseline.submissions,
    `${baseline.submissions} submission(s), as before`);
  t("the bucket is exactly as it was before this run",
    (await client.query(`select count(*)::int as n from storage.buckets where id = 'style-photos'`)).rows[0].n === baseline.bucket,
    baseline.bucket === 1 ? "0052 applied, so it stays" : "0052 not applied, so it is gone again");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`\nthrew — rolled back, nothing written:\n  ${e.message}`);
  fail++;
} finally {
  await client.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

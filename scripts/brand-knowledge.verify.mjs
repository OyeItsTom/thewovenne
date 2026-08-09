/**
 * Prove 0051 — brand knowledge survives both carry-through points.
 *
 *   node scripts/brand-knowledge.verify.mjs
 *
 * INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK, with the migration applied
 * inside it, so the rule is exercised against the real database before being
 * added to it — the same shape as scripts/cancel-guard.verify.mjs.
 *
 * THE TWO ASSERTIONS THAT MATTER are the ones 0037 failed: that a draft forked
 * from a published version still carries the notes (ensure_product_draft copies
 * an explicit column list), and that publishing that draft copies them onto
 * `products` (0038's trigger). A column can exist, be writable, be readable, and
 * still be silently dropped by either of those, which is exactly what makes this
 * worth testing rather than reading.
 *
 * It writes to a REAL product's draft version. Nothing commits, and the
 * published rows are read back afterwards to prove it.
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

const HERITAGE = "Woven on pit looms in Chendamangalam, a Kerala tradition older than the mill.";
const CRAFT = "Kasavu border, thrown by hand; the slubs are the fibre, not a fault.";
const CARE = "Cold hand wash, dry in shade, iron while damp. Never wring a kasavu border.";

try {
  await client.connect();

  const { rows: before } = await client.query(
    `select count(*)::int as written from products
      where heritage_note is not null or craft_note is not null or care_note is not null`
  ).catch(() => ({ rows: [{ written: 0 }] }));
  console.log(`baseline: ${before[0].written} product(s) written up\n`);

  await client.query("begin");
  await client.query(
    fs.readFileSync("supabase/migrations/0051_product_brand_knowledge.sql", "utf8")
  );

  const { rows: cols } = await client.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name in ('products', 'product_versions')
        and column_name in ('heritage_note', 'craft_note', 'care_note')`
  );
  check("six columns exist", cols[0].n === 6, `${cols[0].n} of 6`);

  // ── Become an admin for this transaction only ──
  const { rows: admins } = await client.query(
    `select id from profiles where is_admin = true order by created_at limit 1`
  );
  await client.query(
    `select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
    [admins[0].id]
  );
  check("the session reads as an admin", (await client.query("select public.is_admin() as ok")).rows[0].ok === true);

  // ── A real published product to work on ──
  const { rows: targets } = await client.query(
    `select product_id, id, name, version from product_versions
      where state = 'published' order by created_at limit 1`
  );
  if (targets.length === 0) throw new Error("no published product to exercise");
  const target = targets[0];
  console.log(`\n=== A. writing to a draft of "${target.name}" ===`);

  // No draft may exist yet, or the fork returns the existing one and proves
  // nothing about copying.
  await client.query(`delete from product_versions where product_id = $1 and state = 'draft'`, [
    target.product_id,
  ]);

  const { rows: forked } = await client.query(`select public.ensure_product_draft($1) as id`, [
    target.product_id,
  ]);
  const draftId = forked[0].id;
  check("a draft was forked", Boolean(draftId));

  await client.query(
    `update product_versions
        set heritage_note = $2, craft_note = $3, care_note = $4
      where id = $1`,
    [draftId, HERITAGE, CRAFT, CARE]
  );
  const { rows: draftRow } = await client.query(
    `select heritage_note, craft_note, care_note from product_versions where id = $1`,
    [draftId]
  );
  check("the notes are on the draft", draftRow[0].heritage_note === HERITAGE);
  check("all three, not just the first", draftRow[0].craft_note === CRAFT && draftRow[0].care_note === CARE);

  // ══ B. THE FIRST CARRY-THROUGH: forking again from a published version ══
  // Publish this draft, then fork a second draft from it — that second fork is
  // the code path 0037 broke. If ensure_product_draft's column list is missing a
  // name, the notes are gone here and nowhere else.
  console.log("\n=== B. publish, then fork again ===");
  await client.query(
    `update product_versions set state = 'archived' where product_id = $1 and state = 'published'`,
    [target.product_id]
  );
  await client.query(`update product_versions set state = 'published' where id = $1`, [draftId]);

  const { rows: published } = await client.query(
    `select heritage_note, craft_note, care_note from products where id = $1`,
    [target.product_id]
  );
  check(
    "the publish trigger copied all three onto products",
    published[0].heritage_note === HERITAGE &&
      published[0].craft_note === CRAFT &&
      published[0].care_note === CARE,
    "0038's sync_published_product_extras"
  );

  const { rows: forkedAgain } = await client.query(`select public.ensure_product_draft($1) as id`, [
    target.product_id,
  ]);
  const { rows: secondDraft } = await client.query(
    `select heritage_note, craft_note, care_note from product_versions where id = $1`,
    [forkedAgain[0].id]
  );
  check(
    "a second draft carries all three forward",
    secondDraft[0].heritage_note === HERITAGE &&
      secondDraft[0].craft_note === CRAFT &&
      secondDraft[0].care_note === CARE,
    "the trap that lost hsn_code in 0037"
  );

  // ══ C. The ceiling ══
  console.log("\n=== C. the length ceiling ===");
  const tooLong = await refused(
    "c1",
    `update product_versions set craft_note = repeat('x', 4001) where id = $1`,
    [forkedAgain[0].id]
  );
  check("4001 characters is refused", tooLong !== null, tooLong?.split("\n")[0]);
  await client.query(
    `update product_versions set craft_note = repeat('x', 4000) where id = $1`,
    [forkedAgain[0].id]
  );
  check("4000 is accepted", true, "a paragraph has room; a pasted document does not");

  // ══ D. Nobody else can write them ══
  // The columns are on a table only admins may write, so the guarantee is 0003's
  // RLS rather than anything new — asserted here so a future grant that widened
  // it would show up as a failure in this file.
  console.log("\n=== D. who may write them ===");
  const { rows: grants } = await client.query(
    `select count(*)::int as n from information_schema.role_column_grants
      where table_name = 'product_versions'
        and column_name in ('heritage_note', 'craft_note', 'care_note')
        and grantee in ('anon')
        and privilege_type in ('INSERT', 'UPDATE')`
  );
  check("anon has no insert or update grant", grants[0].n === 0, `${grants[0].n} grants`);

  // ══ Nothing survives ══
  await client.query("rollback");
  const { rows: after } = await client.query(
    `select count(*)::int as written from products
      where heritage_note is not null or craft_note is not null or care_note is not null`
  ).catch(() => ({ rows: [{ written: -1 }] }));
  const { rows: colsAfter } = await client.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'products' and column_name = 'heritage_note'`
  );
  const { rows: statesAfter } = await client.query(
    `select count(*)::int as n from product_versions where state = 'published'`
  );
  console.log("\n=== after rollback ===");
  check("the columns are gone until the migration is applied", colsAfter[0].n === 0);
  check(
    "no product was left written up",
    after[0].written === -1 || after[0].written === before[0].written,
    "the column no longer exists, so nothing was left behind"
  );
  check("published versions are untouched", statesAfter[0].n === 4, `${statesAfter[0].n} published`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`\nthrew — rolled back, nothing written:\n  ${e.message}`);
  fail++;
} finally {
  await client.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

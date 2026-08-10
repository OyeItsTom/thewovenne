/**
 * Prove 0056 — a sized product's total is its sizes, and an unsized one is left alone.
 *
 *   node scripts/derived-stock.verify.mjs
 *
 * Inside one transaction that is always rolled back. This one is worth being
 * thorough about: the triggers fire on paths nobody calls directly — a sale, a
 * publish, a draft fork — so the test exercises those paths rather than the
 * triggers, which is the only way to know the real thing is covered.
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
const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];

await c.connect();
const baseline = await one("select (select count(*)::int from products) p, (select count(*)::int from orders) o");

try {
  await c.query("begin");

  // RECREATE THE DRIFT rather than rely on finding it. This originally asserted
  // that 001 held 2 against sizes of 13 — true when it was written and false the
  // moment the migration was applied, so the test failed on its second run for
  // the best possible reason. Putting the wrong number back inside the
  // transaction makes it prove the same thing every time.
  //
  // The trigger has to be held off to plant it, because once 0056 is applied to
  // the database the guard corrects the bad number the instant it is written —
  // which is the fix demonstrating itself, and made the second run of this file
  // fail. The migration re-creates the trigger below, so it comes back enabled.
  await c.query(`do $$ begin
    if exists (select 1 from pg_trigger where tgrelid = 'product_versions'::regclass
                 and tgname = 'derive_stock_from_sizes') then
      alter table product_versions disable trigger derive_stock_from_sizes;
    end if;
  end $$;`);
  await c.query(`update product_versions pv set stock_quantity = 2
    from products p where p.id = pv.product_id and p.slug = '001' and pv.state = 'published'`);
  const before = await one(`select pv.stock_quantity from product_versions pv
    join products p on p.id = pv.product_id where p.slug = '001' and pv.state = 'published'`);
  const sizesTotal = await one(`select coalesce(sum(ps.stock_quantity),0)::int total from product_sizes ps
    join products p on p.id = ps.product_id where p.slug = '001'`);

  await c.query(fs.readFileSync("supabase/migrations/0056_sized_stock_is_derived.sql", "utf8"));

  console.log("\n=== the row that prompted this ===");
  const after = await one(`select pv.stock_quantity from product_versions pv
    join products p on p.id = pv.product_id where p.slug = '001' and pv.state = 'published'`);
  t("the drift is in place to be fixed", before.stock_quantity === 2, `set to ${before.stock_quantity}, sizes hold 13`);
  t("its sizes total 13", sizesTotal.total === 13, String(sizesTotal.total));
  t("and it now reads 13", after.stock_quantity === 13, String(after.stock_quantity));

  const archived = await one(`select count(distinct pv.stock_quantity)::int kinds, min(pv.stock_quantity)::int val
    from product_versions pv join products p on p.id = pv.product_id
    where p.slug='001' and pv.state='archived'`);
  t("archived versions were NOT rewritten", archived.kinds === 1 && archived.val === 2,
    `${archived.kinds} distinct value(s), = ${archived.val} — history is what was on the shelf then`);

  console.log("\n=== a sale keeps it true ===");
  const prod = await one("select id from products where slug = '001'");
  const sizeBefore = await one("select label, stock_quantity from product_sizes where product_id=$1 order by label limit 1", [prod.id]);
  await c.query(
    `update product_sizes set stock_quantity = stock_quantity - 1 where product_id=$1 and label=$2`,
    [prod.id, sizeBefore.label]
  );
  const afterSale = await one(`select stock_quantity from product_versions where product_id=$1 and state='published'`, [prod.id]);
  t("selling one drops the version total to 12", afterSale.stock_quantity === 12, String(afterSale.stock_quantity));

  console.log("\n=== the form cannot write a wrong number ===");
  await c.query(`update product_versions set stock_quantity = 999 where product_id=$1 and state='published'`, [prod.id]);
  const afterTyping = await one(`select stock_quantity from product_versions where product_id=$1 and state='published'`, [prod.id]);
  t("typing 999 is replaced by the real sum", afterTyping.stock_quantity === 12, String(afterTyping.stock_quantity),);

  console.log("\n=== a product with no sizes is untouched ===");
  const plain = await one("select id, slug from products where slug = 'mul-cotton'");
  await c.query(`update product_versions set stock_quantity = 42 where product_id=$1 and state='published'`, [plain.id]);
  const plainAfter = await one(`select stock_quantity from product_versions where product_id=$1 and state='published'`, [plain.id]);
  t("a saree still takes the number it is given", plainAfter.stock_quantity === 42, String(plainAfter.stock_quantity),
    );

  console.log("\n=== adding sizes to an unsized product ===");
  await c.query(`insert into product_sizes (product_id, label, stock_quantity, sort_order) values ($1,'S',3,0),($1,'M',5,1)`, [plain.id]);
  const nowSized = await one(`select stock_quantity from product_versions where product_id=$1 and state='published'`, [plain.id]);
  t("it becomes the sum the moment sizes exist", nowSized.stock_quantity === 8, String(nowSized.stock_quantity));

  console.log("\n=== removing every size hands it back ===");
  await c.query("delete from product_sizes where product_id=$1", [plain.id]);
  const unsized = await one(`select stock_quantity from product_versions where product_id=$1 and state='published'`, [plain.id]);
  t("the last value is kept rather than zeroed", unsized.stock_quantity === 8, String(unsized.stock_quantity),
    );
  await c.query(`update product_versions set stock_quantity = 20 where product_id=$1 and state='published'`, [plain.id]);
  const manualAgain = await one(`select stock_quantity from product_versions where product_id=$1 and state='published'`, [plain.id]);
  t("and it is manually editable again", manualAgain.stock_quantity === 20, String(manualAgain.stock_quantity));

  console.log("\n=== a new draft inherits the truth ===");
  // ensure_product_draft is gated on is_admin(), and this connection is a
  // superuser with no JWT — so it has to ask as somebody. Impersonated inside a
  // savepoint and handed back afterwards, because the assertions after this one
  // write directly and would be caught by RLS.
  await c.query("savepoint as_admin");
  const admin = await one("select id, email from profiles where is_admin limit 1");
  await c.query("set local role authenticated");
  await c.query(`set local request.jwt.claims = '${JSON.stringify({ sub: admin.id, email: admin.email })}'`);
  await c.query("select public.ensure_product_draft($1)", [prod.id]);
  await c.query("reset role");
  const draft = await one(`select stock_quantity from product_versions where product_id=$1 and state='draft'`, [prod.id]);
  t("a forked draft carries the derived total", draft.stock_quantity === 12, String(draft.stock_quantity));

  console.log("\n=== nothing disagrees any more ===");
  const drift = await one(`select count(*)::int n from product_versions pv
    where pv.state in ('draft','published')
      and public.product_size_total(pv.product_id) is not null
      and pv.stock_quantity is distinct from public.product_size_total(pv.product_id)`);
  t("no live version of a sized product disagrees with its sizes", drift.n === 0, `${drift.n} disagreeing`);
} catch (e) {
  t("the migration ran without raising", false, e.message.slice(0, 160));
} finally {
  await c.query("rollback");
  const now = await one("select (select count(*)::int from products) p, (select count(*)::int from orders) o");
  t("nothing was left behind", now.p === baseline.p && now.o === baseline.o,
    `products ${baseline.p}→${now.p}, orders ${baseline.o}→${now.o}`);
  await c.end();
}

console.log(`\n${ok} passed, ${bad} failed\n`);
process.exit(bad === 0 ? 0 : 1);

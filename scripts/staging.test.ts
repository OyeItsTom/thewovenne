/**
 * Staging can be rebuilt from nothing, refilled, and reset — proved on a
 * throwaway Postgres, never a Supabase project.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/staging.test.ts
 *
 * What it checks, in the order staging is used:
 *   1. bootstrap: an EMPTY database (Supabase's own schemas only) reaches the
 *      latest migration through applyPendingMigrations, every file recorded
 *      as applied now rather than "retrospectively"; a second run is a no-op;
 *      a database with tables but no ledger, and a gap below the newest
 *      applied file, are both refused.
 *   2. every table the migrations create is classified for reset.
 *   3. seed: the baseline catalogue goes in through the admin RPCs and what an
 *      anonymous shopper can see is exactly the published part of it.
 *   4. reset: customer activity is gone, staff and structure remain, and a
 *      re-seed produces the same baseline.
 *
 * Without embedded-postgres (see scripts/pg-world.ts) the DB half is skipped
 * and the run says so; it does not pass by default.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SUPABASE_SHIM, makeAdmin, startEngine, type Client } from "./pg-world";
import {
  STAGING_CATALOGUE,
  TABLE_POLICY,
  applyPendingMigrations,
  clearDisposable,
  migrationFiles,
  seedCatalogue,
  unclassifiedTables,
} from "./lib/staging.mjs";
import { compareFingerprints, fingerprint } from "./lib/schemaFingerprint.mjs";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}
async function failure(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

console.log("\nclassification is well-formed");
const both = TABLE_POLICY.disposable.filter((x) => TABLE_POLICY.retained.includes(x));
t("no table is both disposable and retained", both.length === 0, both.join(", "));
t("the ledger is never cleared", !TABLE_POLICY.disposable.includes("schema_migrations"));
t("profiles are not truncated (staff must survive)", !TABLE_POLICY.disposable.includes("profiles"));
t("catalogue has an in-stock, sold-out, sized, pending and draft-only product",
  ["in-stock", "sold-out", "sized", "pending-change", "draft-only"].every((k) => STAGING_CATALOGUE.some((e) => e.key === k)));
t("every seed slug is marked as staging", STAGING_CATALOGUE.every((e) => e.slug.startsWith("staging-") && e.name.startsWith("Staging ")));

(async () => {
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database half — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (DB SKIPPED)\n`);
    process.exit(fail ? 1 : 2);
  }

  /** A database holding only what a new Supabase project holds before any migration. */
  async function freshProject(name: string): Promise<Client> {
    const root = await engine!.connect("postgres");
    await root.query(`create database ${name}`);
    await root.end();
    const c = await engine!.connect(name);
    await c.query(SUPABASE_SHIM);
    return c;
  }

  try {
    console.log("\nbootstrap from empty");
    const c = await freshProject("staging_a");
    const files = migrationFiles();
    const first = await applyPendingMigrations(c);
    t(`all ${files.length} migrations applied in order`, first.applied.length === files.length && first.applied.join() === files.join());
    const ledger = (await c.query("select filename, applied_at, recorded_retrospectively from schema_migrations order by 1")).rows;
    t("every file is in the ledger", ledger.length === files.length);
    t("none is marked retrospective — they were applied by this run", ledger.every((r) => !r.recorded_retrospectively && r.applied_at));
    const second = await applyPendingMigrations(c);
    t("a second bootstrap applies nothing", second.applied.length === 0);

    console.log("\nbootstrap refuses what it should");
    const d = await freshProject("staging_b");
    await d.query("create table public.stray (id int)");
    t("tables without a ledger → refused", (await failure(() => applyPendingMigrations(d))).includes("not a fresh staging project"));
    await d.end();

    const gapDir = fs.mkdtempSync(path.join(os.tmpdir(), "wovenne-gap-"));
    for (const f of files) fs.copyFileSync(path.join("supabase/migrations", f), path.join(gapDir, f));
    const e = await freshProject("staging_c");
    const skipped = files[files.length - 3];
    fs.renameSync(path.join(gapDir, skipped), path.join(gapDir, `${skipped}.held`));
    await applyPendingMigrations(e, { dir: gapDir });
    fs.renameSync(path.join(gapDir, `${skipped}.held`), path.join(gapDir, skipped));
    t("a file numbered below the newest applied one → refused",
      (await failure(() => applyPendingMigrations(e, { dir: gapDir }))).includes("out-of-order"));
    await e.end();
    fs.rmSync(gapDir, { recursive: true, force: true });

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "wovenne-broken-"));
    fs.writeFileSync(path.join(broken, "0001_ok.sql"), "create table public.one (id int);");
    fs.writeFileSync(path.join(broken, "0002_bad.sql"), "create table public.two (id int); select nonsense_function();");
    const f = await freshProject("staging_d");
    const msg = await failure(() => applyPendingMigrations(f, { dir: broken }));
    const two = (await f.query("select to_regclass('public.two') is not null ok")).rows[0].ok;
    t("a failing migration names itself and leaves nothing half-applied", msg.includes("0002_bad.sql") && !two);
    await f.end();
    fs.rmSync(broken, { recursive: true, force: true });

    console.log("\nevery table is classified");
    const unknown = await unclassifiedTables(c);
    t("no unclassified tables after the latest migration", unknown.length === 0, unknown.join(", "));
    const { rows: real } = await c.query(
      "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
    );
    const names = new Set(real.map((r) => r.table_name));
    const ghosts = [...TABLE_POLICY.disposable, ...TABLE_POLICY.retained].filter((x) => !names.has(x));
    t("TABLE_POLICY names no table that does not exist", ghosts.length === 0, ghosts.join(", "));

    console.log("\nschema fingerprint");
    await engine.database("reference");
    const ref = await engine.connect("reference");
    const fpStaging = await fingerprint(c);
    const fpRef = await fingerprint(ref);
    t("fingerprint covers columns, policies, functions, grants, triggers, buckets",
      ["columns", "policies", "functions", "function_grants", "table_grants", "triggers", "buckets"].every((k) => (fpStaging[k]?.length ?? 0) > 0));
    const same = compareFingerprints(fpStaging, fpRef);
    t("bootstrap's schema is identical to the harness's own replay", Object.keys(same).length === 0, JSON.stringify(same).slice(0, 300));
    // The F03 kind of drift — a function body changed by hand — must show up.
    await ref.query("create or replace function public.is_staff() returns boolean language sql security definer stable set search_path = public, pg_temp as $f$ select true $f$");
    const drift = compareFingerprints(fpStaging, await fingerprint(ref));
    t("a hand-edited function body is reported", (drift.functions?.onlyB ?? []).some((x) => x.startsWith("is_staff()")), JSON.stringify(drift).slice(0, 200));
    await ref.query("drop policy if exists \"Public can view images of active products\" on product_images");
    t("a dropped policy is reported", (compareFingerprints(fpStaging, await fingerprint(ref)).policies?.onlyA ?? []).length > 0);
    await ref.end();

    console.log("\nseed");
    const admin = await makeAdmin(c, "staging-admin@example.test");
    const imageUrl = (p: string) => `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/product-images/${p}`;
    const placeholders = (await c.query("select count(*)::int n from products")).rows[0].n;
    t("0007's placeholder products are present before seeding", placeholders === 10, String(placeholders));
    const made = await seedCatalogue(c, { adminId: admin, imageUrl });
    t("every catalogue entry was created", Object.keys(made).length === STAGING_CATALOGUE.length);

    // What the shop shows: published versions, through RLS, as anon.
    await c.query("set role anon");
    const visible = (await c.query("select slug, stock_quantity, name from product_versions where state = 'published' order by slug")).rows;
    await c.query("reset role");
    const slugs = visible.map((r) => r.slug);
    t("shoppers see the four published products and nothing else",
      slugs.join() === STAGING_CATALOGUE.filter((x) => x.publish).map((x) => x.slug).sort().join(), slugs.join(", "));
    t("draft-only product is not visible", !slugs.includes("staging-draft-only-saree"));
    // By id, not slug: a never-published draft's identity row keeps the random
    // placeholder slug create_product_draft gave it (0022).
    t("no 0007 placeholder survives",
      (await c.query("select count(*)::int n from products where not (id = any($1))", [Object.values(made)])).rows[0].n === 0);
    const by = Object.fromEntries(visible.map((r) => [r.slug, r]));
    t("in-stock product has stock", by["staging-cotton-saree"]?.stock_quantity === 5);
    t("sold-out product has 0", by["staging-sold-out-saree"]?.stock_quantity === 0);
    t("sized product's total is its sizes (3+0+2)", by["staging-sized-kurti"]?.stock_quantity === 5);
    const sizes = (await c.query(
      "select label, stock_quantity from product_sizes where product_id = $1 order by sort_order, label", [made["sized"]]
    )).rows.map((r) => `${r.label}:${r.stock_quantity}`);
    t("sizes S:3 M:0 L:2", sizes.join() === "S:3,M:0,L:2", sizes.join());
    t("pending-change product shows its LIVE name", by["staging-pending-change-saree"]?.name === "Staging Pending Change Saree");
    const pending = (await c.query("select name from product_versions where product_id = $1 and state = 'draft'", [made["pending-change"]])).rows;
    t("…with the edit waiting as a draft", pending.length === 1 && pending[0].name.includes("not published"));
    const imgs = (await c.query("select url from product_images")).rows.map((r) => r.url);
    t("images point at the staging project's products/ folder",
      imgs.length > 0 && imgs.every((u) => u.startsWith("https://abcdefghijklmnopqrst.supabase.co/") && /\/products\/staging-[a-z-]+-\d\.jpg$/.test(u)));
    await c.query("set role anon");
    const cat = (await c.query("select is_visible from categories where slug = 'kurtis'")).rows[0];
    await c.query("reset role");
    t("the sized product's category is visible", cat?.is_visible === true);

    console.log("\nreset");
    // Customer activity, the way the app would leave it.
    const { rows: [cust] } = await c.query("insert into auth.users (email) values ('shopper@example.test') returning id");
    await c.query("insert into profiles (id, email) values ($1, 'shopper@example.test') on conflict (id) do nothing", [cust.id]);
    await c.query("insert into wishlists (user_id, product_id) values ($1, $2)", [cust.id, made["in-stock"]]);
    await c.query("insert into carts (user_id, items) values ($1, '[]'::jsonb)", [cust.id]);
    await c.query("insert into orders (items, total_inr, payment_status, status, customer_email) values ('[]', 1, 'paid', 'placed', 'shopper@example.test')");
    await clearDisposable(c);
    const counts: Record<string, number> = {};
    for (const tb of TABLE_POLICY.disposable) {
      counts[tb] = (await c.query(`select count(*)::int n from public.${tb}`)).rows[0].n;
    }
    t("every disposable table is empty", Object.values(counts).every((n) => n === 0),
      Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(", "));
    t("staff profile survives", (await c.query("select is_admin from profiles where id = $1", [admin])).rows[0]?.is_admin === true);
    t("ledger survives", (await c.query("select count(*)::int n from schema_migrations")).rows[0].n === files.length);
    t("categories survive", (await c.query("select count(*)::int n from categories")).rows[0].n > 0);

    await c.query("create table public.new_customer_data (id int)");
    t("an unclassified table makes reset refuse",
      (await failure(() => clearDisposable(c))).includes("new_customer_data"));
    await c.query("drop table public.new_customer_data");

    const again = await seedCatalogue(c, { adminId: admin, imageUrl });
    await c.query("set role anon");
    const visible2 = (await c.query("select slug, stock_quantity from product_versions where state='published' order by slug")).rows;
    await c.query("reset role");
    t("re-seed after reset gives the same baseline",
      JSON.stringify(visible2) === JSON.stringify(visible.map(({ slug, stock_quantity }) => ({ slug, stock_quantity }))));
    t("re-seed made new products, not leftovers", again["in-stock"] !== made["in-stock"]);

    const { rows: [notStaff] } = await c.query("insert into auth.users (email) values ('x@example.test') returning id");
    await c.query("insert into profiles (id, email) values ($1, 'x@example.test') on conflict (id) do nothing", [notStaff.id]);
    t("seeding as a non-staff account is refused",
      (await failure(() => seedCatalogue(c, { adminId: notStaff.id, imageUrl }))).includes("not staff"));
    t("…and the refused seed changed nothing",
      (await c.query("select count(*)::int n from products")).rows[0].n === STAGING_CATALOGUE.length);

    await c.end();
  } finally {
    await engine.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

/**
 * 0060 — who can change stock, and what a caller can make the stock functions
 * read. On a real, throwaway PostgreSQL (scripts/pg-world.ts) whose shim grants
 * the API roles what Supabase grants them by default — every new table and
 * function, and (as a worst case) CREATE on public — so a refusal here is the
 * migration refusing, not the test database being stingy.
 *
 * SHADOWING. A SECURITY DEFINER function with `search_path = public` looks in
 * the caller's temporary schema FIRST for tables. Each shadowing check is run
 * against the database before 0060 and asserted to go wrong there, then
 * against 0060 and asserted to be ignored — so a pass means the fix did it.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/stock-security.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { asAdmin, asRoot, asService, failure, handToOwner, makeAdmin, startEngine, type Client } from "./pg-world";
import { liveProduct, liveRow, movements, nameOnlyDraft, paidOrder, sell, sizesOf } from "./stock-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const denied = (msg: string) => /permission denied/.test(msg);

/** A caller-owned temporary table named exactly like a real one. */
async function shadow(c: Client, table: string) {
  // stock_requests is unreadable to the API roles (so LIKE cannot copy it);
  // its shadow is spelled out instead.
  if (table === "stock_requests") {
    await c.query(`create temp table if not exists stock_requests (request_id uuid primary key, product_id uuid,
      operation text, digest text, outcome jsonb default '{}', actor_id uuid, created_at timestamptz default now())`);
    return;
  }
  await c.query(`create temp table if not exists ${table} (like public.${table} including defaults)`);
}

/** 0060 exactly as scripts/run-migration.mjs applies it: one transaction, as `owner`. */
async function apply0060As(c: Client, owner: string): Promise<string> {
  const sql = fs.readFileSync("supabase/migrations/0060_publish_keeps_live_stock.sql", "utf8");
  await c.query("begin");
  try {
    await c.query(`set local role ${owner}`);
    await c.query(sql);
    await c.query("commit");
    return "";
  } catch (e) {
    await c.query("rollback");
    return (e as Error).message;
  }
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway), Supabase-style default grants`);

  try {
    await engine.database("old", "0059");
    await engine.database("new");

    // ══ Shadowing: the defect, then the fix ══
    for (const db of ["old", "new"] as const) {
      const before = db === "old";
      const tag = before ? "BEFORE 0060" : "0060";
      console.log(`\n=== shadow tables — ${tag} ===`);
      const root = await engine.connect(db);
      const admin = await makeAdmin(root);

      // Sized: a temporary product_sizes row claiming 99 of size M.
      {
        const p = await liveProduct(root, admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
        const vid = await nameOnlyDraft(root, admin, p.productId, "Renamed");
        const s = await engine.connect(db);
        await asAdmin(s, admin);
        await shadow(s, "product_sizes");
        await s.query("insert into pg_temp.product_sizes (id, product_id, label, stock_quantity, sort_order) values (gen_random_uuid(), $1, 'M', 99, 0)", [p.productId]);
        await s.query("update product_versions set description = 'touched' where id = $1", [vid]);
        await s.query("select public.publish_one('product', $1)", [p.productId]);
        await s.end();
        const live = (await liveRow(root, p.productId))!.stock_quantity;
        check(`${tag}: sized — a caller's temp product_sizes ${before ? "SETS live stock to 99" : "is ignored; live stock is the real 2"}`,
          live, before ? 99 : 2);
        check(`${tag}: sized — the real sizes are untouched`, await sizesOf(root, p.productId), { M: 2 });
      }

      // Unsized: a temp row makes an unsized product look sized.
      {
        const p = await liveProduct(root, admin, { stock: 1 });
        const vid = await nameOnlyDraft(root, admin, p.productId, "Renamed");
        const s = await engine.connect(db);
        await asAdmin(s, admin);
        await shadow(s, "product_sizes");
        await s.query("insert into pg_temp.product_sizes (id, product_id, label, stock_quantity, sort_order) values (gen_random_uuid(), $1, 'X', 99, 0)", [p.productId]);
        await s.query("update product_versions set description = 'touched' where id = $1", [vid]);
        await s.query("select public.publish_one('product', $1)", [p.productId]);
        await s.end();
        check(`${tag}: unsized — a temp product_sizes row ${before ? "SETS live stock to 99" : "is ignored; live stock stays 1"}`,
          (await liveRow(root, p.productId))!.stock_quantity, before ? 99 : 1);
      }

      // A sale made from a session whose temp product_sizes is EMPTY: the
      // sized product looks unsized.
      {
        const p = await liveProduct(root, admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
        const o = await paidOrder(root, [{ id: p.productId, size: "M", quantity: 1 }]);
        const s = await engine.connect(db);
        await asService(s);
        await shadow(s, "product_sizes");
        const out = await failure(() => s.query("select public.reserve_stock($1::jsonb, $2)", [JSON.stringify([{ id: p.productId, size: "M", quantity: 1 }]), o]));
        await s.end();
        const sizes = await sizesOf(root, p.productId);
        check(`${tag}: sale — an empty temp product_sizes ${before ? "makes the sale skip the size (M stays 2)" : "is ignored; size M goes 2 → 1"}`,
          [out, sizes.M], before ? ["", 2] : ["", 1]);
      }
      await root.end();
    }

    // ══ 0060 applied by a non-superuser, as in production ══
    console.log("\n=== 0060 applied by an ordinary role that owns the schema, as production's `postgres` ===");
    {
      await engine.database("nonsuper", "0059");
      const root = await engine.connect("nonsuper");
      await handToOwner(root, "nonsuper", "migrator");
      const before = (await root.query("select md5(prosrc) m from pg_proc where proname = 'publish_one'")).rows[0].m;
      check("0060 applies, self-check included", await apply0060As(root, "migrator"), "");
      const owners = (await root.query(`select distinct pg_get_userbyid(proowner) o from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('publish_one', 'set_product_stock', 'claim_stock_request', 'save_product_sizes', 'guard_live_stock', 'product_size_total')`)).rows.map((r) => r.o);
      check("its functions are owned by that role", owners, ["migrator"]);
      check("publish_one was really replaced", (await root.query("select md5(prosrc) m from pg_proc where proname = 'publish_one'")).rows[0].m !== before, true);
      const privs = (await root.query(`select has_schema_privilege('anon', 'public', 'CREATE') a, has_schema_privilege('authenticated', 'public', 'CREATE') b,
        has_table_privilege('authenticated', 'product_sizes', 'UPDATE') c, has_function_privilege('anon', 'public.publish_one(text, uuid, text)', 'EXECUTE') d`)).rows[0];
      check("its revokes took effect without superuser", [privs.a, privs.b, privs.c, privs.d], [false, false, false, false]);
      // And it works: the acceptance test, against functions owned by an ordinary role.
      const admin = await makeAdmin(root, "ns-admin@example.test");
      const p = await liveProduct(root, admin, { stock: 1 });
      await nameOnlyDraft(root, admin, p.productId, "Renamed NS");
      const o = await paidOrder(root, [{ id: p.productId, quantity: 1 }]);
      await sell(root, o, [{ id: p.productId, quantity: 1 }]);
      await asAdmin(root, admin);
      await root.query("select public.publish_one('product', $1)", [p.productId]);
      const r = (await root.query("select public.set_product_stock($1, 0, 2, gen_random_uuid()) r", [p.productId])).rows[0].r;
      await asRoot(root);
      check("acceptance: stock stays 0 through publish; a checked adjustment then applies",
        [r.status, (await liveRow(root, p.productId))!.stock_quantity, (await liveRow(root, p.productId))!.name], ["applied", 2, "Renamed NS"]);
      await root.end();
    }

    console.log("\n=== 0060 refuses to half-apply when it cannot revoke a grant ===");
    {
      await engine.database("foreigngrant", "0059");
      const root = await engine.connect("foreigngrant");
      await handToOwner(root, "foreigngrant", "migrator");
      // CREATE on public reaches anon through ANOTHER role's grant — the case a
      // non-superuser's REVOKE cannot touch.
      await root.query(`do $$ begin create role other_grantor nologin; exception when duplicate_object then null; end $$`);
      await root.query("grant create on schema public to other_grantor with grant option");
      await root.query("set role other_grantor; grant create on schema public to anon; reset role");
      const before = (await root.query("select md5(prosrc) m from pg_proc where proname = 'publish_one'")).rows[0].m;
      const err = await apply0060As(root, "migrator");
      check("the migration refuses, naming the grant", /MIGRATION_0060_SELF_CHECK_FAILED: .*anon can still CREATE in schema public/.test(err), true);
      check("…and nothing was applied: no stock_requests, publish_one untouched",
        [(await root.query("select to_regclass('public.stock_requests') is null n")).rows[0].n,
         (await root.query("select md5(prosrc) m from pg_proc where proname = 'publish_one'")).rows[0].m === before], [true, true]);
      await root.query("set role other_grantor; revoke create on schema public from anon; reset role");
      check("once that grant is revoked by its grantor, the same file applies", await apply0060As(root, "migrator"), "");
      await root.end();
    }

    console.log("\n=== 0060 fails cleanly when it does not own something it replaces ===");
    {
      await engine.database("foreignowner", "0059");
      const root = await engine.connect("foreignowner");
      await handToOwner(root, "foreignowner", "migrator");
      await root.query(`do $$ begin create role someone_else nologin; exception when duplicate_object then null; end $$`);
      await root.query("alter function public.is_admin() owner to someone_else");
      const err = await apply0060As(root, "migrator");
      check("refused: must be owner", /must be owner of function (public\.)?is_admin/.test(err), true);
      check("…and nothing was applied", (await root.query("select to_regclass('public.stock_requests') is null n")).rows[0].n, true);
      await root.end();
    }

    // ══ Everything shadowed at once, 0060 only ══
    console.log("\n=== 0060: every table the stock paths touch, shadowed, while the whole flow runs ===");
    const root = await engine.connect("new");
    const admin = await makeAdmin(root, "sec-admin@example.test");
    {
      const TABLES = ["products", "product_versions", "product_sizes", "stock_movements", "stock_requests",
        "orders", "product_images", "admin_audit_log", "product_url_history", "profiles", "credit_notes",
        "categories", "category_versions"];
      const u = await liveProduct(root, admin, { stock: 3 });
      const z = await liveProduct(root, admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
      const zSize = (await root.query("select id from product_sizes where product_id = $1", [z.productId])).rows[0].id as string;
      await nameOnlyDraft(root, admin, u.productId, "U renamed");
      await nameOnlyDraft(root, admin, z.productId, "Z renamed");
      const o = await paidOrder(root, [{ id: u.productId, quantity: 1 }, { id: z.productId, size: "M", quantity: 1 }]);

      const svc = await engine.connect("new");
      await asService(svc);
      for (const t of TABLES) await shadow(svc, t);
      await svc.query("insert into pg_temp.product_sizes (id, product_id, label, stock_quantity, sort_order) values (gen_random_uuid(), $1, 'X', 50, 0)", [u.productId]);
      const sale = await failure(() => svc.query("select public.reserve_stock($1::jsonb, $2)",
        [JSON.stringify([{ id: u.productId, quantity: 1 }, { id: z.productId, size: "M", quantity: 1 }]), o]));

      const adm = await engine.connect("new");
      await asAdmin(adm, admin);
      for (const t of TABLES) await shadow(adm, t);
      await adm.query("insert into pg_temp.product_sizes (id, product_id, label, stock_quantity, sort_order) values (gen_random_uuid(), $1, 'X', 50, 0)", [u.productId]);
      const steps = [
        await failure(() => adm.query("select public.set_product_stock($1, 2, 5, $2)", [u.productId, randomUUID()])),
        await failure(() => adm.query("select public.save_product_sizes($1, $2::jsonb, null, $3)",
          [z.productId, JSON.stringify([{ id: zSize, label: "M", expected: 1, stock_quantity: 4 }]), randomUUID()])),
        await failure(() => adm.query("select public.publish_one('product', $1)", [u.productId])),
        await failure(() => adm.query("select public.publish_all()")),
        await failure(() => adm.query("select public.cancel_order($1, 'test')", [o])),
      ];
      check("the sale and every admin step succeed with everything shadowed", [sale, ...steps], ["", "", "", "", "", ""]);

      let leaked = 0;
      for (const c of [svc, adm]) for (const t of TABLES) {
        const n = (await c.query(`select count(*)::int n from pg_temp.${t}`)).rows[0].n as number;
        leaked += n - (t === "product_sizes" ? 1 : 0);
      }
      check("no function read from or wrote to a caller's temp table (only the decoys are there)", leaked, 0);
      await svc.end();
      await adm.end();

      const U = (await liveRow(root, u.productId))!;
      check("unsized: 3 − 1 sold, set 2 → 5, publish keeps 5, cancel returns 1 → 6", [U.name, U.stock_quantity], ["U renamed", 6]);
      check("sized: M 2 − 1 sold, set 1 → 4, cancel returns 1 → 5", (await sizesOf(root, z.productId)).M, 5);
      check("sized: its version total follows the real sizes", (await liveRow(root, z.productId))!.stock_quantity, 5);
      const ms = (await movements(root, u.productId)).map((m) => [m.reason, m.delta]);
      check("unsized history: sale, correction, cancellation", ms, [["sale", -1], ["correction", 3], ["cancellation", 1]]);
    }

    // ══ Configuration ══
    console.log("\n=== every function on a stock path resolves names with pg_temp last ===");
    {
      const { rows } = await root.query(`
        select p.oid::regprocedure::text fn
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and (p.oid in (select t.tgfoid from pg_trigger t
                           where not t.tgisinternal
                             and t.tgrelid in ('products'::regclass, 'product_versions'::regclass, 'product_sizes'::regclass,
                                               'stock_movements'::regclass, 'orders'::regclass, 'credit_notes'::regclass))
                or p.proname in ('product_size_total', 'is_admin', 'product_path', 'issue_credit_note', 'validate_publish',
                                 'ensure_product_draft', 'create_product_draft', 'draft_is_noop', 'settle_draft',
                                 'gallery_matches', 'pending_queue', 'pending_changes', 'discard_one', 'discard_drafts',
                                 'checkout_prices', 'reserve_stock', 'release_stock', 'cancel_order', 'claim_stock_request',
                                 'set_product_stock', 'save_product_sizes', 'publish_one', 'publish_all'))
           and not (coalesce(p.proconfig, '{}') @> array['search_path=public, pg_temp'])`);
      check("functions called by these paths or fired by their writes, without pg_temp last", rows.map((r) => r.fn), []);
      const n = (await root.query("select count(*)::int n from pg_trigger where not tgisinternal and tgrelid in ('product_versions'::regclass, 'product_sizes'::regclass, 'orders'::regclass)")).rows[0].n;
      check("…and the trigger list it checked is not empty", n >= 8, true);
      check("the API roles cannot create objects in public",
        [(await root.query("select has_schema_privilege('authenticated', 'public', 'CREATE') a, has_schema_privilege('anon', 'public', 'CREATE') b")).rows[0]].map((r) => [r.a, r.b])[0],
        [false, false]);
    }

    // ══ Who may call what ══
    console.log("\n=== EXECUTE: anon, authenticated, service_role ===");
    {
      const matrix: [string, boolean, boolean, boolean][] = [
        ["public.reserve_stock(jsonb, uuid)", false, false, true],
        ["public.release_stock(jsonb, uuid, text)", false, false, true],
        ["public.cancel_order(uuid, text)", false, true, true],
        ["public.set_product_stock(uuid, integer, integer, uuid, text, text)", false, true, true],
        ["public.save_product_sizes(uuid, jsonb, text, uuid)", false, true, true],
        ["public.publish_one(text, uuid, text)", false, true, true],
        ["public.publish_all()", false, true, true],
        ["public.claim_stock_request(uuid, uuid, text, text)", false, false, true],
        ["public.guard_live_stock()", false, false, true],
      ];
      for (const [fn, anon, auth, svc] of matrix) {
        const r = (await root.query(
          "select has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') b, has_function_privilege('service_role', $1, 'EXECUTE') c",
          [fn])).rows[0];
        check(`${fn}: anon/authenticated/service_role`, [r.a, r.b, r.c], [anon, auth, svc]);
      }
      const pub = (await root.query(`
        select p.oid::regprocedure::text fn from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where p.pronamespace = 'public'::regnamespace and a.grantee = 0 and a.privilege_type = 'EXECUTE'
           and p.proname in ('reserve_stock', 'release_stock', 'cancel_order', 'set_product_stock', 'save_product_sizes',
                             'publish_one', 'publish_all', 'claim_stock_request', 'guard_live_stock')`)).rows.map((r) => r.fn);
      check("none of them is executable by PUBLIC", pub, []);
      const overloads = (await root.query(`
        select proname, count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace
           and proname in ('reserve_stock', 'release_stock', 'cancel_order', 'set_product_stock', 'save_product_sizes',
                           'publish_one', 'publish_all', 'claim_stock_request')
         group by 1 having count(*) > 1`)).rows;
      check("no leftover overloads (the old save_product_sizes is gone)", overloads, []);
      const owners = (await root.query(`
        select distinct pg_get_userbyid(proowner) o from pg_proc where pronamespace = 'public'::regnamespace
           and proname in ('reserve_stock', 'release_stock', 'cancel_order', 'set_product_stock', 'save_product_sizes',
                           'publish_one', 'publish_all', 'claim_stock_request', 'guard_live_stock', 'product_size_total',
                           'derive_version_stock', 'resync_versions_from_sizes')`)).rows.map((r) => r.o);
      check("owned by the migration role, never an API role", owners, ["postgres"]);
    }

    // ══ Calls that must be refused ══
    console.log("\n=== refused callers ===");
    {
      const p = await liveProduct(root, admin, { stock: 2 });
      const o = await paidOrder(root, [{ id: p.productId, quantity: 1 }]);
      await asRoot(root);
      const shopperId = (await root.query("insert into auth.users (email) values ('shopper2@example.test') returning id")).rows[0].id;
      const c = await engine.connect("new");
      const calls: [string, unknown[]][] = [
        ["select public.set_product_stock($1, 2, 3, gen_random_uuid())", [p.productId]],
        ["select public.save_product_sizes($1, '[]'::jsonb)", [p.productId]],
        ["select public.publish_one('product', $1)", [p.productId]],
        ["select public.publish_all()", []],
        ["select public.cancel_order($1)", [o]],
      ];
      await c.query("set role anon");
      for (const [sql, args] of calls) check(`anon: ${sql.slice(14, 40)}… permission denied`, denied(await failure(() => c.query(sql, args))), true);
      await asAdmin(c, shopperId);
      for (const [sql, args] of calls) check(`signed-in non-admin: ${sql.slice(14, 40)}… refused as not an admin`, /Only admins/.test(await failure(() => c.query(sql, args))), true);
      for (const who of ["anon", "authenticated"]) {
        if (who === "anon") await c.query("set role anon");
        else await asAdmin(c, admin);
        check(`${who} (even an admin): reserve_stock denied`, denied(await failure(() => c.query("select public.reserve_stock('[]'::jsonb, null)"))), true);
        check(`${who} (even an admin): release_stock denied`, denied(await failure(() => c.query("select public.release_stock('[]'::jsonb, null, 'return')"))), true);
        check(`${who} (even an admin): claim_stock_request denied`, denied(await failure(() => c.query("select public.claim_stock_request(gen_random_uuid(), $1, 'set_product_stock', 'x')", [p.productId]))), true);
      }
      await asService(c);
      check("service_role: reserve_stock allowed", await failure(() => c.query("select public.reserve_stock($1::jsonb, $2)", [JSON.stringify([{ id: p.productId, quantity: 1 }]), o])), "");
      check("service_role: set_product_stock still requires an admin", /Only admins/.test(await failure(() => c.query("select public.set_product_stock($1, 1, 3, gen_random_uuid())", [p.productId]))), true);
      await c.end();
      check("…and none of the refused calls moved stock", (await liveRow(root, p.productId))!.stock_quantity, 1);
    }

    // ══ Direct writes ══
    console.log("\n=== direct writes by the API roles ===");
    {
      const p = await liveProduct(root, admin, { stock: 2 });
      const z = await liveProduct(root, admin, { sizes: [{ label: "M", stock_quantity: 1 }] });
      const draft = await nameOnlyDraft(root, admin, p.productId, "Draft");
      const live = (await liveRow(root, p.productId))!;
      const c = await engine.connect("new");
      await asAdmin(c, admin);
      const tries: [string, string, unknown[], (m: string) => boolean][] = [
        ["live stock", "update product_versions set stock_quantity = 9 where id = $1", [live.id], (m) => m === "LIVE_STOCK_LOCKED"],
        ["stock in a live product's draft", "update product_versions set stock_quantity = 9 where id = $1", [draft], (m) => m === "STOCK_IS_LIVE"],
        ["promote a draft by writing state", "update product_versions set state = 'published' where id = $1", [draft], (m) => m === "VERSION_STATE_LOCKED"],
        ["archive the live version by writing state", "update product_versions set state = 'archived' where id = $1", [live.id], (m) => m === "VERSION_STATE_LOCKED"],
        ["insert an archived version", "insert into product_versions (product_id, state, version, name, slug, price_inr) values ($1, 'archived', 99, 'x', 'x-archived', 1)", [p.productId], (m) => m === "VERSION_STATE_LOCKED"],
        ["insert a fabricated movement", "insert into stock_movements (product_id, delta, reason) values ($1, 5, 'restock')", [p.productId], denied],
        ["alter a movement", "update stock_movements set delta = 100 where product_id = $1", [p.productId], denied],
        ["delete movements", "delete from stock_movements where product_id = $1", [p.productId], denied],
        ["write a size", "update product_sizes set stock_quantity = 50 where product_id = $1", [z.productId], denied],
        ["insert a size", "insert into product_sizes (product_id, label, stock_quantity) values ($1, 'XL', 5)", [z.productId], denied],
        ["read or forge request claims", "insert into stock_requests (request_id, product_id, operation, digest) values (gen_random_uuid(), $1, 'set_product_stock', 'x')", [p.productId], denied],
        ["create a table in public", "create table public.product_sizes_evil (id int)", [], denied],
      ];
      for (const [what, sql, args, ok] of tries) {
        const m = await failure(() => c.query(sql, args));
        check(`admin session, ${what}: refused`, ok(m), true);
      }
      check("…the admin can still read the movement log", await failure(() => c.query("select count(*) from stock_movements")), "");
      check("…and still save a descriptive draft change", await failure(() => c.query("update product_versions set description = 'ok', is_active = true where id = $1", [draft])), "");
      check("…and still mark a draft for deletion", await failure(() => c.query("update product_versions set pending_delete = false where id = $1", [draft])), "");
      const newVid = (await c.query("select public.create_product_draft() id")).rows[0].id;
      check("…and still set a NEW product's opening stock on its draft",
        await failure(() => c.query("update product_versions set stock_quantity = 4, name = 'New', slug = 'new-sec', price_inr = 10 where id = $1", [newVid])), "");
      await c.query("set role anon");
      await failure(() => c.query("update product_versions set stock_quantity = 77 where product_id = $1", [p.productId]));
      await c.end();
      check("anon's attempt changed nothing", (await liveRow(root, p.productId))!.stock_quantity, 2);
      check("the shelf is exactly as it was after all of that", [(await liveRow(root, p.productId))!.stock_quantity, (await sizesOf(root, z.productId)).M], [2, 1]);
      const svc = await engine.connect("new");
      await asService(svc);
      check("service_role (trusted server code) is not blocked by the guard",
        await failure(() => svc.query("update product_versions set stock_quantity = 2 where id = $1", [live.id])), "");
      await svc.end();
    }

    // ══ Request ids ══
    console.log("\n=== request ids are bound to one product, one operation, one payload ===");
    {
      const p = await liveProduct(root, admin, { stock: 1 });
      const q = await liveProduct(root, admin, { stock: 1 });
      const c = await engine.connect("new");
      await asAdmin(c, admin);
      const id = randomUUID();
      check("a refused request (stale expected) …",
        await failure(() => c.query("select public.set_product_stock($1, 5, 2, $2)", [p.productId, id])), "STOCK_CHANGED:1");
      check("…does not spend its id", (await root.query("select count(*)::int n from stock_requests where request_id = $1", [id])).rows[0].n, 0);
      const r = (await c.query("select public.set_product_stock($1, 1, 2, $2) r", [p.productId, id])).rows[0].r;
      check("the id is then free for a real request", r.status, "applied");
      check("the same id on ANOTHER product is refused", await failure(() => c.query("select public.set_product_stock($1, 1, 2, $2)", [q.productId, id])), "REQUEST_ID_REUSED");
      check("the same id for a sizes save is refused", await failure(() => c.query("select public.save_product_sizes($1, '[]'::jsonb, null, $2)", [p.productId, id])), "REQUEST_ID_REUSED");
      check("…and neither touched anything", [(await liveRow(root, p.productId))!.stock_quantity, (await liveRow(root, q.productId))!.stock_quantity], [2, 1]);
      const claim = (await root.query("select product_id, operation, actor_id, outcome ->> 'status' s from stock_requests where request_id = $1", [id])).rows[0];
      check("the claim records product, operation, actor and outcome", [claim.product_id, claim.operation, claim.actor_id, claim.s], [p.productId, "set_product_stock", admin, "applied"]);

      const z = await liveProduct(root, admin, { sizes: [{ label: "M", stock_quantity: 2 }] });
      const y = await liveProduct(root, admin, { sizes: [{ label: "M", stock_quantity: 7 }] });
      const zM = (await root.query("select id from product_sizes where product_id = $1", [z.productId])).rows[0].id;
      await asAdmin(c, admin);
      const body = JSON.stringify([{ id: zM, label: "M", expected: 2, stock_quantity: 3 }]);
      const sid = randomUUID();
      check("sizes: applied", (await c.query("select public.save_product_sizes($1, $2::jsonb, null, $3) r", [z.productId, body, sid])).rows[0].r.status, "applied");
      const again = (await c.query("select public.save_product_sizes($1, $2::jsonb, null, $3) r", [z.productId, body, sid])).rows[0].r;
      check("sizes: identical retry is already_applied with the first answer", [again.status, again.logged], ["already_applied", 1]);
      check("…and wrote no second movement", (await movements(root, z.productId)).filter((m) => m.request_id === sid).length, 1);
      check("sizes: the same id with a different payload is refused",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb, null, $3)",
          [z.productId, JSON.stringify([{ id: zM, label: "M", expected: 2, stock_quantity: 9 }]), sid])), "REQUEST_ID_REUSED");
      check("sizes: a payload built from product Z's sizes, sent for product Y, is refused",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb, null, $3)",
          [y.productId, JSON.stringify([{ id: zM, label: "M", expected: 3, stock_quantity: 1 }]), randomUUID()])), "STOCK_CHANGED:M:gone");
      check("sizes: a row id whose name does not match is refused",
        await failure(() => c.query("select public.save_product_sizes($1, $2::jsonb)",
          [z.productId, JSON.stringify([{ id: zM, label: "XL", expected: 3, stock_quantity: 1 }])])), "SIZE_MISMATCH:XL");
      check("…and neither product's sizes moved", [(await sizesOf(root, z.productId)).M, (await sizesOf(root, y.productId)).M], [3, 7]);
      await c.end();
    }
    await root.end();
  } finally {
    await engine.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

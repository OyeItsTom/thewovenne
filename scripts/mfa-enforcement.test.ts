/**
 * 0061 / 0062 — admin authority requires a two-factor-verified session; staff
 * identity (for routing to the second factor) does not.
 *
 * On a real PostgreSQL with every migration applied unmodified
 * (scripts/pg-world.ts), across the three database states a staged rollout
 * passes through:
 *
 *   A  through 0060  — the database before this change
 *   B  through 0061  — is_staff() added, nothing else changed
 *   C  through 0062  — is_admin() requires aal2
 *
 * and for each session a request can carry. Then the application's login
 * routing, old and new, is evaluated against each state, so the rollout order
 * is proven rather than asserted: no state it passes through locks staff out.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/mfa-enforcement.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import fs from "node:fs";
import { asRoot, asService, asUser, handToOwner, makeAdmin, startEngine, type Client } from "./pg-world";
import { liveProduct, nameOnlyDraft, paidOrder } from "./stock-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

type Actor = { label: string; as: (c: Client) => Promise<void> };
const outcome = (p: Promise<unknown>) => p.then(() => "allowed", (e: Error) =>
  /permission denied/.test(e.message) ? "denied" : /Only admins|not allowed|violates row-level/.test(e.message) ? "refused" : `error: ${e.message}`);

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);
  const states = [["A", "0060", "before this change"], ["B", "0061", "is_staff added"], ["C", "0062", "is_admin requires aal2"]] as const;
  const loginOutcome: Record<string, Record<string, string>> = {};

  try {
    for (const [state, through, what] of states) {
      console.log(`\n=== state ${state} — migrations through ${through} (${what}) ===`);
      const db = `mfa${state.toLowerCase()}`;
      await engine.database(db, through);
      const c = await engine.connect(db);
      const staff = await makeAdmin(c, "staff@example.test");
      // Fixture made with a two-factor-verified admin, as the real admin works.
      await asUser(c, staff, "aal2");
      const p = await liveProduct(c, staff, { stock: 3 });
      await asRoot(c);
      const order = await paidOrder(c, [{ id: p.productId, quantity: 1 }]);
      const draft = await nameOnlyDraft(c, staff, p.productId, "Draft");
      await asRoot(c);
      const customer = (await c.query("insert into auth.users (email) values ('customer@example.test') returning id")).rows[0].id as string;
      const hasStaffFn = (await c.query("select to_regprocedure('public.is_staff()') is not null v")).rows[0].v as boolean;

      const actors: Actor[] = [
        { label: "anonymous", as: async (x) => { await asRoot(x); await x.query("set role anon"); } },
        { label: "customer (aal1)", as: (x) => asUser(x, customer, "aal1") },
        { label: "staff, password only (aal1)", as: (x) => asUser(x, staff, "aal1") },
        { label: "staff, two-factor done (aal2)", as: (x) => asUser(x, staff, "aal2") },
        { label: "staff, token without aal", as: (x) => asUser(x, staff, null) },
        { label: "staff, unexpected aal value", as: async (x) => {
            await x.query("set role authenticated");
            await x.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
              [staff, JSON.stringify({ sub: staff, role: "authenticated", aal: "AAL2 " })]); } },
        { label: "staff, claims missing (sub only)", as: async (x) => {
            await x.query("set role authenticated");
            await x.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', '', false)", [staff]); } },
      ];

      const rows: Record<string, Record<string, unknown>> = {};
      for (const a of actors) {
        const r: Record<string, unknown> = {};
        const q = async (sql: string, args: unknown[] = []) => { await a.as(c); try { return await c.query(sql, args); } finally { await asRoot(c); } };
        r.is_admin = await q("select public.is_admin() v").then((x) => x.rows[0].v, (e) => /permission denied/.test(e.message) ? "denied" : "error");
        if (hasStaffFn) r.is_staff = await q("select public.is_staff() v").then((x) => x.rows[0].v, (e) => /permission denied/.test(e.message) ? "denied" : "error");
        r.orders = await q("select count(*)::int n from orders").then((x) => x.rows[0].n, () => "denied");
        r.profiles = await q("select count(*)::int n from profiles").then((x) => x.rows[0].n, () => "denied");
        r.audit = await q("select count(*)::int n from admin_audit_log").then((x) => x.rows[0].n, () => "denied");
        r.stock_rpc = await outcome(q("select public.set_product_stock($1, 3, 3, gen_random_uuid())", [p.productId]));
        r.customers_rpc = await q("select count(*)::int n from public.admin_customers()").then((x) => `rows=${x.rows[0].n}`, (e) => /permission denied/.test(e.message) ? "denied" : /admin/i.test(e.message) ? "refused" : "error");
        r.draft_write = await q("update product_versions set description = 'x' where id = $1 returning id", [draft]).then((x) => (x.rowCount ? "allowed" : "no rows"), () => "denied");
        r.storefront_read = await q("select count(*)::int n from product_versions where state = 'published'").then((x) => x.rows[0].n > 0 ? "rows" : "none", () => "denied");
        rows[a.label] = r;
      }
      // Service role — bypasses RLS; the one admin-or-service function keeps working.
      await asService(c);
      const svcAnalytics = await c.query("select public.can_read_analytics() v").then((x) => x.rows[0].v, (e) => `error: ${e.message}`);
      await asRoot(c);

      const S = rows["staff, password only (aal1)"], V = rows["staff, two-factor done (aal2)"];
      const lockedToAal2 = state === "C";
      check(`${state}: staff with two-factor done is admin, reads everything, may act`,
        [V.is_admin, V.orders, V.profiles, V.stock_rpc, V.customers_rpc, V.draft_write], [true, 1, 2, "allowed", "rows=1", "allowed"]);
      check(`${state}: staff with a password only is ${lockedToAal2 ? "REFUSED everywhere" : "still admin (the gap this closes)"}`,
        [S.is_admin, S.orders, S.profiles, S.audit === 0 || S.audit === "denied" ? "none" : "some", S.stock_rpc, S.customers_rpc, S.draft_write],
        lockedToAal2 ? [false, 0, 1, "none", "refused", "refused", "no rows"] : [true, 1, 2, "some", "allowed", "rows=1", "allowed"]);
      for (const label of ["staff, token without aal", "staff, unexpected aal value", "staff, claims missing (sub only)"]) {
        const R = rows[label];
        check(`${state}: ${label} — ${lockedToAal2 ? "fails closed" : "admin, as before"}`,
          [R.is_admin, R.orders, R.stock_rpc], lockedToAal2 ? [false, 0, "refused"] : [true, 1, "allowed"]);
      }
      if (hasStaffFn) {
        check(`${state}: is_staff() recognises staff at every level and nobody else`,
          actors.map((a) => [a.label, rows[a.label].is_staff]),
          [["anonymous", "denied"], ["customer (aal1)", false], ["staff, password only (aal1)", true], ["staff, two-factor done (aal2)", true],
           ["staff, token without aal", true], ["staff, unexpected aal value", true], ["staff, claims missing (sub only)", true]]);
      }
      const C = rows["customer (aal1)"], An = rows["anonymous"];
      check(`${state}: customer unchanged — own profile only, no orders, no admin powers`,
        [C.is_admin, C.orders, C.profiles, C.stock_rpc, C.customers_rpc, C.draft_write], [false, 0, 1, "refused", "refused", "no rows"]);
      // orders: "denied", not 0 rows — under the privilege baseline, as in
      // production, anon holds no grant on orders at all, so RLS is never reached.
      check(`${state}: anonymous unchanged — storefront readable, nothing else`,
        [An.storefront_read, An.orders, An.stock_rpc], ["rows", "denied", "denied"]);
      check(`${state}: service role still reads analytics`, svcAnalytics, true);

      // The login step, as each version of the app performs it: right after the
      // password (aal1), ask whether this is staff, then send them to /admin/mfa.
      const oldApp = S.is_admin === true ? "reaches two-factor step" : "turned away (lockout)";
      const newApp = !hasStaffFn ? "turned away (lockout)" : S.is_staff === true ? "reaches two-factor step" : "turned away (lockout)";
      loginOutcome[state] = { "old app (asks is_admin)": oldApp, "new app (asks is_staff)": newApp };
      await c.end();
    }

    console.log("\n=== staged rollout — staff login at each point ===");
    for (const s of ["A", "B", "C"]) console.log(`  ${s}: ${JSON.stringify(loginOutcome[s])}`);
    check("rollout step 1: old app on A (today) — staff reach the second factor", loginOutcome.A["old app (asks is_admin)"], "reaches two-factor step");
    check("rollout step 2: old app on B (0061 applied) — unchanged", loginOutcome.B["old app (asks is_admin)"], "reaches two-factor step");
    check("rollout step 3: new app on B — staff reach the second factor", loginOutcome.B["new app (asks is_staff)"], "reaches two-factor step");
    check("rollout step 4: new app on C (0062 applied) — staff reach the second factor", loginOutcome.C["new app (asks is_staff)"], "reaches two-factor step");
    check("WRONG ORDER is detected: new app on A (before 0061) would lock staff out", loginOutcome.A["new app (asks is_staff)"], "turned away (lockout)");
    check("WRONG ORDER is detected: old app on C (0062 before the app) would lock staff out", loginOutcome.C["old app (asks is_admin)"], "turned away (lockout)");

    // ── Applied as production applies migrations: one transaction each, as a
    //    non-superuser owner (Supabase's postgres is not a superuser) ──
    console.log("\n=== 0061 / 0062 applied by a non-superuser owner ===");
    {
      const apply = async (c: Client, file: string) => {
        await c.query("begin");
        try { await c.query("set local role migrator_mfa"); await c.query(fs.readFileSync(`supabase/migrations/${file}`, "utf8")); await c.query("commit"); return ""; }
        catch (e) { await c.query("rollback"); return (e as Error).message; }
      };
      await engine.database("mfaprod", "0060");
      const c = await engine.connect("mfaprod");
      await handToOwner(c, "mfaprod", "migrator_mfa");
      const aclBefore = (await c.query("select proacl::text a from pg_proc where oid = 'public.is_admin()'::regprocedure")).rows[0].a;
      check("0062 refuses to run before 0061", /requires 0061/.test(await apply(c, "0062_is_admin_requires_aal2.sql")), true);
      check("0061 applies", await apply(c, "0061_is_staff.sql"), "");
      check("0062 applies, its self-check included", await apply(c, "0062_is_admin_requires_aal2.sql"), "");
      const after = (await c.query(`select proacl::text a, pg_get_userbyid(proowner) o, array_to_string(proconfig, ',') cfg
        from pg_proc where oid = 'public.is_admin()'::regprocedure`)).rows[0];
      check("is_admin(): grants unchanged, owner the migration role, pg_temp last", [after.a === aclBefore, after.o, after.cfg],
        [true, "migrator_mfa", "search_path=public, pg_temp"]);
      const staffFn = (await c.query(`select pg_get_userbyid(proowner) o, array_to_string(proconfig, ',') cfg,
        has_function_privilege('anon', oid, 'EXECUTE') anon, has_function_privilege('authenticated', oid, 'EXECUTE') auth
        from pg_proc where oid = 'public.is_staff()'::regprocedure`)).rows[0];
      check("is_staff(): owner the migration role, pg_temp last, authenticated only", [staffFn.o, staffFn.cfg, staffFn.anon, staffFn.auth],
        ["migrator_mfa", "search_path=public, pg_temp", false, true]);
      const staff = await makeAdmin(c, "prodstaff@example.test");
      await asUser(c, staff, "aal1");
      const pw = (await c.query("select public.is_staff() s, public.is_admin() a")).rows[0];
      await asUser(c, staff, "aal2");
      const mfa = (await c.query("select public.is_staff() s, public.is_admin() a")).rows[0];
      await asRoot(c);
      check("owned by a non-superuser, the functions answer as intended", [pw.s, pw.a, mfa.s, mfa.a], [true, false, true, true]);
      await c.end();
    }

    // ── The application's call sites ──
    console.log("\n=== application call sites ===");
    const read = (f: string) => fs.readFileSync(f, "utf8");
    const mw = read("middleware.ts");
    check("middleware routes on is_staff (identity), never on is_admin", [/rpc\("is_staff"\)/.test(mw), /rpc\("is_admin"\)/.test(mw)], [true, false]);
    check("middleware still requires aal2 for admin pages", /currentLevel !== "aal2"/.test(mw), true);
    check("admin login step asks checkStaff()", /checkStaff\(\)/.test(read("app/(admin)/admin/login/page.tsx")), true);
    check("customer login form recognises staff via is_staff", /rpc\("is_staff"\)/.test(read("lib/customerAuth.ts")), true);
    check("checkout recognises staff via is_staff", /rpc\("is_staff"\)/.test(read("lib/checkoutIdentity.ts")), true);
    check("dashboard chrome (after the second factor) asks is_admin", /isCurrentUserAdmin\(\)/.test(read("components/admin/DashboardChrome.tsx")), true);
    const apiDir = "app/api/admin";
    const routes: string[] = [];
    const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const pth = `${d}/${f}`; fs.statSync(pth).isDirectory() ? walk(pth) : f === "route.ts" && routes.push(pth); } };
    walk(apiDir);
    const bad = routes.filter((r) => {
      const s = read(r);
      const gate = s.search(/\.rpc\("is_admin"\)/);
      const svc = s.search(/createServiceClient\(\)/);
      return gate < 0 || /rpc\("is_staff"\)/.test(s) || (svc >= 0 && svc < gate);
    });
    check(`every admin API route (${routes.length}) authorises with is_admin before any service-role client`, bad, []);
    check("preview authorises with is_admin", [/rpc\("is_admin"\)/.test(read("app/api/preview/route.ts")), /rpc\("is_admin"\)/.test(read("lib/preview.ts"))], [true, true]);
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

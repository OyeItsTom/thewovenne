/**
 * 0067 — database admin authority ends when the admin's session ends.
 *
 * Before 0067, is_admin() trusted the access token's claims (staff + aal2). A
 * copy of an admin access token taken before sign-out or idle expiry kept admin
 * RLS on the Data API until the token itself expired (up to an hour), although
 * the session behind it had been deleted at Supabase Auth.
 *
 * On a real PostgreSQL with every migration applied unmodified
 * (scripts/pg-world.ts), this:
 *
 *   1. reproduces that on a database through 0066 — the session is deleted,
 *      the same token is still an admin;
 *   2. applies 0067 to that very database — the same token is refused;
 *   3. runs the full matrix on a clean replay through the latest migration;
 *   4. applies 0067 as production does — one transaction, as a non-superuser
 *      owner shaped like Supabase's postgres — and proves its guards refuse the
 *      states that would lock every admin out or replace an unknown function;
 *   5. checks the application ends sessions AT SUPABASE on sign-out and idle
 *      expiry, which is what makes (2) cover both;
 *   6. measures what the extra lookup costs.
 *
 * "Sign-out" and "idle revocation" are modelled as what Supabase Auth does for
 * them: delete the auth.sessions row (all of the user's rows for a global
 * sign-out). Removing a second factor lowers the user's sessions to aal1.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/admin-db-session.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import fs from "node:fs";
import { asRoot, asUser, failure, handToOwner, makeAdmin, startEngine, type Client } from "./pg-world";
import { liveProduct, paidOrder } from "./stock-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const MIGRATION = "supabase/migrations/0067_is_admin_requires_live_session.sql";

/** A session as Supabase Auth creates it on sign-in, raised to `aal` after a second factor. */
async function newSession(c: Client, userId: string, aal: "aal1" | "aal2", notAfter: string | null = null) {
  await asRoot(c);
  return (await c.query("insert into auth.sessions (id, user_id, aal, not_after) values (gen_random_uuid(), $1, $2, $3::timestamptz) returning id",
    [userId, aal, notAfter])).rows[0].id as string;
}

/** A request carrying exactly these claims, as PostgREST presents a token. */
async function presenting(c: Client, claims: Record<string, unknown>) {
  await asRoot(c);
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [String(claims.sub ?? ""), JSON.stringify({ role: "authenticated", ...claims })]);
}

const token = (sub: string, session: string | null, aal = "aal2") =>
  ({ sub, aal, ...(session === null ? {} : { session_id: session }) });

async function isAdmin(c: Client): Promise<boolean | string> {
  try {
    return (await c.query("select public.is_admin() a")).rows[0].a as boolean;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

/** Sign-out / idle expiry, as Supabase Auth carries it out. */
async function endSession(c: Client, session: string) {
  await asRoot(c);
  await c.query("delete from auth.sessions where id = $1", [session]);
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);

  try {
    // ── 1 + 2. The defect, then the fix, on the same database ──
    console.log("\n=== the stolen token: through 0066, then 0067 applied ===");
    {
      await engine.database("sessold", "0066");
      const c = await engine.connect("sessold");
      const admin = await makeAdmin(c, "admin@example.test");
      const s = await newSession(c, admin, "aal2");
      const stolen = token(admin, s);
      await presenting(c, stolen);
      check("0066: the live admin token is an admin", await isAdmin(c), true);
      await presenting(c, stolen);
      const before = Number((await c.query("select count(*) n from orders")).rows[0].n);
      await endSession(c, s);
      await presenting(c, stolen);
      check("DEFECT REPRODUCED (0066): after sign-out the copied token is STILL an admin", await isAdmin(c), true);
      await asRoot(c);
      await paidOrder(c, [{ id: "00000000-0000-0000-0000-000000000000", quantity: 1 }]);
      await presenting(c, stolen);
      check("DEFECT REPRODUCED (0066): …and still reads every order through admin RLS",
        Number((await c.query("select count(*) n from orders")).rows[0].n), before + 1);

      await asRoot(c);
      await c.query(fs.readFileSync(MIGRATION, "utf8"));
      await presenting(c, stolen);
      check("FIXED (0067 applied): the same copied token is not an admin", await isAdmin(c), false);
      check("FIXED (0067 applied): …and reads no orders", Number((await c.query("select count(*) n from orders")).rows[0].n), 0);
      const fresh = await newSession(c, admin, "aal2");
      await presenting(c, token(admin, fresh));
      check("a fresh sign-in with MFA is an admin again", await isAdmin(c), true);
      await asRoot(c);
      await c.end();
    }

    // ── 3. The matrix, on a clean replay of every migration ──
    console.log("\n=== clean replay, every migration ===");
    await engine.database("sessnew");
    const c = await engine.connect("sessnew");
    check("clean replay applies every migration, 0067's self-check included", true, true);
    const admin = await makeAdmin(c, "admin@example.test");
    const otherAdmin = await makeAdmin(c, "second@example.test");
    await asRoot(c);
    const customer = (await c.query("insert into auth.users (email) values ('shopper@example.test') returning id")).rows[0].id as string;
    await c.query("insert into profiles (id, email) values ($1, 'shopper@example.test') on conflict (id) do nothing", [customer]);
    const product = await liveProduct(c, admin, { stock: 2 });
    await paidOrder(c, [{ id: product.productId, quantity: 1 }]);

    console.log("\n=== who is an admin ===");
    const live = await newSession(c, admin, "aal2");
    await presenting(c, token(admin, live));
    check("1. staff + aal2 token + live aal2 session → admin", await isAdmin(c), true);

    const pw = await newSession(c, admin, "aal1");
    await presenting(c, token(admin, pw, "aal1"));
    check("2. staff at aal1 (password only) → refused", await isAdmin(c), false);
    await presenting(c, token(admin, pw, "aal2"));
    check("2b. aal2 claim on a session that is only aal1 → refused", await isAdmin(c), false);

    const cs = await newSession(c, customer, "aal1");
    await presenting(c, token(customer, cs, "aal1"));
    check("3. customer with a live session → refused", await isAdmin(c), false);
    const cs2 = await newSession(c, customer, "aal2");
    await presenting(c, token(customer, cs2, "aal2"));
    check("3b. customer even at aal2 with a live aal2 session → refused", await isAdmin(c), false);

    await asRoot(c);
    await c.query("set role anon");
    await c.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', false), set_config('request.jwt.claim.sub', '', false)");
    const anonAnswer = await isAdmin(c);
    check("4. anonymous → refused (cannot even execute is_admin)", /permission denied/.test(String(anonAnswer)), true);
    check("4b. anonymous cannot read orders at all", /permission denied/.test(await failure(() => c.query("select count(*) from orders"))), true);

    console.log("\n=== sessions that have ended ===");
    const revoked = await newSession(c, admin, "aal2");
    const keep = await newSession(c, admin, "aal2");
    await endSession(c, revoked);
    await presenting(c, token(admin, revoked));
    check("5. token whose session was revoked/removed → refused", await isAdmin(c), false);
    await presenting(c, token(admin, keep));
    check("5b. …while the admin's other live session is unaffected (local sign-out)", await isAdmin(c), true);

    const a = await newSession(c, admin, "aal2");
    const b = await newSession(c, admin, "aal2");
    await asRoot(c);
    await c.query("delete from auth.sessions where user_id = $1", [admin]); // global sign-out
    await presenting(c, token(admin, a));
    const afterA = await isAdmin(c);
    await presenting(c, token(admin, b));
    check("6. explicit (global) sign-out → every copied token refused", [afterA, await isAdmin(c)], [false, false]);

    const idle = await newSession(c, admin, "aal2");
    await presenting(c, token(admin, idle));
    const beforeIdle = await isAdmin(c);
    await endSession(c, idle); // the idle path's signOut({ scope: "local" })
    await presenting(c, token(admin, idle));
    check("7. idle expiry (server revokes the session) → refused", [beforeIdle, await isAdmin(c)], [true, false]);

    const own = await newSession(c, admin, "aal2");
    const theirs = await newSession(c, otherAdmin, "aal2");
    await presenting(c, token(admin, "6f1c2a52-6c0c-4c55-9a51-0d0b4f6e0d11"));
    check("8. session_id naming no session → refused", await isAdmin(c), false);
    await presenting(c, token(admin, theirs));
    check("8b. session_id of ANOTHER admin's live aal2 session → refused", await isAdmin(c), false);
    await presenting(c, token(admin, cs2));
    check("8c. session_id of a customer's session → refused", await isAdmin(c), false);
    await presenting(c, token(admin, "not-a-uuid"));
    check("8d. malformed session_id → refused, not an error", await isAdmin(c), false);
    await presenting(c, { ...token(admin, null), session_id: 42 });
    check("8e. non-string session_id → refused, not an error", await isAdmin(c), false);

    await presenting(c, token(admin, null));
    check("9. no session_id claim → refused", await isAdmin(c), false);
    await presenting(c, { sub: admin, session_id: own });
    check("9b. no aal claim, live aal2 session → refused", await isAdmin(c), false);

    const lapsed = await newSession(c, admin, "aal2", new Date(Date.now() - 60_000).toISOString());
    await presenting(c, token(admin, lapsed));
    check("10. session past not_after → refused", await isAdmin(c), false);
    const boxed = await newSession(c, admin, "aal2", new Date(Date.now() + 3_600_000).toISOString());
    await presenting(c, token(admin, boxed));
    check("10b. session within not_after → admin", await isAdmin(c), true);
    const downgraded = await newSession(c, admin, "aal2");
    await asRoot(c);
    await c.query("update auth.sessions set aal = 'aal1' where id = $1", [downgraded]); // second factor removed
    await presenting(c, token(admin, downgraded));
    check("10c. session lowered to aal1 (factor removed) → refused", await isAdmin(c), false);
    const doomed = await newSession(c, otherAdmin, "aal2");
    await asRoot(c);
    await c.query("update profiles set is_admin = false where id = $1", [otherAdmin]);
    await presenting(c, token(otherAdmin, doomed));
    check("10d. staff flag removed, session still live → refused", await isAdmin(c), false);
    await asRoot(c);
    await c.query("update profiles set is_admin = true where id = $1", [otherAdmin]);

    console.log("\n=== the policies built on is_admin() ===");
    const work = await newSession(c, admin, "aal2");
    await presenting(c, token(admin, work));
    check("11. live admin reads all orders (admin RLS)", Number((await c.query("select count(*) n from orders")).rows[0].n), 1);
    check("11b. live admin reads every profile", Number((await c.query("select count(*) n from profiles")).rows[0].n), 3);
    check("11c. live admin can update a product (admin RLS write)",
      (await c.query("update products set name = name where id = $1", [product.productId])).rowCount, 1);
    check("11d. live admin passes can_read_analytics()", (await c.query("select public.can_read_analytics() v")).rows[0].v, true);
    check("11e. live admin may use an admin RPC", await failure(() => c.query("select public.ensure_product_draft($1)", [product.productId])), "");
    await endSession(c, work);
    await presenting(c, token(admin, work));
    check("11f. same token after sign-out: no orders", Number((await c.query("select count(*) n from orders")).rows[0].n), 0);
    check("11g. …only its own profile", Number((await c.query("select count(*) n from profiles")).rows[0].n), 1);
    check("11h. …updates no product", (await c.query("update products set name = name where id = $1", [product.productId])).rowCount, 0);
    check("11i. …fails can_read_analytics()", (await c.query("select public.can_read_analytics() v")).rows[0].v, false);
    check("11j. …is refused by an admin RPC",
      /admin/i.test(await failure(() => c.query("select public.ensure_product_draft($1)", [product.productId]))), true);

    await asUser(c, customer, "aal1");
    check("12. customer reads only their own profile", (await c.query("select id from profiles")).rows.map((r) => r.id), [customer]);
    check("12b. customer may update their own profile",
      (await c.query("update profiles set full_name = 'Shopper' where id = $1", [customer])).rowCount, 1);
    const customerSees = Number((await c.query("select count(*) n from products")).rows[0].n);
    await asRoot(c);
    const active = Number((await c.query("select count(*) n from products where is_active")).rows[0].n);
    await asUser(c, customer, "aal1");
    check("12c. customer sees exactly the active products", [customerSees > 0, customerSees], [true, active]);
    check("12d. customer cannot read others' orders", Number((await c.query("select count(*) n from orders")).rows[0].n), 0);
    await asUser(c, admin, "aal2");
    check("12e. pg-world asAdmin presents a real session and is an admin", await isAdmin(c), true);

    console.log("\n=== nobody reads auth.sessions ===");
    await asRoot(c);
    const privs = (await c.query(`select r, has_table_privilege(r, 'auth.sessions', 'SELECT') s
      from unnest(array['anon', 'authenticated']) r order by r`)).rows.map((r) => [r.r, r.s]);
    check("13. anon and authenticated hold no SELECT on auth.sessions", privs, [["anon", false], ["authenticated", false]]);
    await presenting(c, token(admin, own));
    check("13b. a live admin reading auth.sessions directly → permission denied",
      /permission denied/.test(await failure(() => c.query("select * from auth.sessions"))), true);
    await asRoot(c);
    await c.query("set role anon");
    check("13c. anon reading auth.sessions → permission denied",
      /permission denied/.test(await failure(() => c.query("select * from auth.sessions"))), true);
    await asRoot(c);
    const fn = (await c.query(`select prorettype::regtype::text t, prosecdef d, array_to_string(proconfig, ',') cfg,
      has_function_privilege('anon', oid, 'EXECUTE') anon from pg_proc where oid = 'public.is_admin()'::regprocedure`)).rows[0];
    check("13d. is_admin() returns boolean only, SECURITY DEFINER, pinned search_path, not for anon",
      [fn.t, fn.d, fn.cfg, fn.anon], ["boolean", true, "search_path=public, pg_temp", false]);
    const staffBody = (await c.query("select prosrc from pg_proc where oid = 'public.is_staff()'::regprocedure")).rows[0].prosrc as string;
    check("13e. is_staff() (routing) is unchanged — no session check", /sessions/.test(staffBody), false);

    // ── 6. Cost ──
    console.log("\n=== cost of the session lookup ===");
    await asRoot(c);
    // Some realistic noise in auth.sessions: many users, many sessions.
    await c.query(`insert into auth.users (email) select 'u' || g || '@example.test' from generate_series(1, 2000) g`);
    await c.query(`insert into auth.sessions (id, user_id, aal) select gen_random_uuid(), id, 'aal1' from auth.users, generate_series(1, 5)`);
    await c.query("analyze auth.sessions");
    const bench = await newSession(c, admin, "aal2");
    await presenting(c, token(admin, bench));
    const time = async (sql: string) => {
      const t0 = process.hrtime.bigint();
      await c.query(sql);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    // 0062's is_admin(), verbatim, beside 0067's — the same harness, the same session.
    await asRoot(c);
    await c.query(`create function public.is_admin_0062() returns boolean language sql security definer stable
      set search_path = public, pg_temp as $f$ select public.is_staff() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'; $f$`);
    await c.query("grant execute on function public.is_admin_0062() to authenticated");
    await presenting(c, token(admin, bench));
    const N = 20000;
    const perCall = async (f: string) => {
      await time(`select count(*) filter (where public.${f}()) from generate_series(1, 100)`); // warm
      return (await time(`select count(*) filter (where public.${f}()) from generate_series(1, ${N})`)) * 1000 / N;
    };
    const old1 = await perCall("is_admin_0062"), new1 = await perCall("is_admin");
    const old2 = await perCall("is_admin_0062"), new2 = await perCall("is_admin");
    const [oldUs, newUs] = [Math.min(old1, old2), Math.min(new1, new2)];
    console.log(`  per call, ${N} calls, 10,000 sessions present: 0062 ${oldUs.toFixed(0)} µs, 0067 ${newUs.toFixed(0)} µs`);
    check("cost: 0067's is_admin() is no more expensive than 0062's", newUs <= oldUs, true);
    await asRoot(c);
    const norm = async (f: string) => ((await c.query(`select prosrc from pg_proc where oid = 'public.${f}()'::regprocedure`)).rows[0].prosrc as string).replace(/\s+/g, "");
    const staffTest = "coalesce((selectp.is_adminfrompublic.profilespwherep.id=auth.uid()),false)";
    check("is_admin()'s staff test is is_staff()'s, verbatim", [(await norm("is_staff")).includes(staffTest), (await norm("is_admin")).includes(staffTest)], [true, true]);
    await asRoot(c);
    const plan = (await c.query(`explain select 1 from auth.sessions s where s.id = '${bench}'::uuid and s.user_id = '${admin}'::uuid and s.aal = 'aal2'`)).rows.map((r) => r["QUERY PLAN"]).join(" ");
    check("cost: the lookup is a primary-key index scan", /Index Scan using sessions_pkey/.test(plan), true);
    await c.end();

    // ── 4. As production applies it ──
    console.log("\n=== 0067 applied as production applies it ===");
    const apply = async (cl: Client, role: string, sql = fs.readFileSync(MIGRATION, "utf8")) => {
      await cl.query("begin");
      try { await cl.query(`set local role ${role}`); await cl.query(sql); await cl.query("commit"); return ""; }
      catch (e) { await cl.query("rollback"); return (e as Error).message; }
    };
    {
      // Like Supabase's postgres: not a superuser, BYPASSRLS, SELECT on auth.sessions.
      await engine.database("sessprod", "0066");
      const p = await engine.connect("sessprod");
      await handToOwner(p, "sessprod", "migrator_sess");
      await p.query("alter role migrator_sess bypassrls; grant select on auth.sessions to migrator_sess");
      const aclBefore = (await p.query("select proacl::text a from pg_proc where oid = 'public.is_admin()'::regprocedure")).rows[0].a;
      check("applies in one transaction as a non-superuser owner, self-check included", await apply(p, "migrator_sess"), "");
      const after = (await p.query(`select proacl::text a, pg_get_userbyid(proowner) o from pg_proc where oid = 'public.is_admin()'::regprocedure`)).rows[0];
      check("grants unchanged, owner unchanged", [after.a === aclBefore, after.o], [true, "migrator_sess"]);
      const staff = await makeAdmin(p, "prodstaff@example.test");
      const s = await newSession(p, staff, "aal2");
      await presenting(p, token(staff, s));
      const yes = await isAdmin(p);
      await endSession(p, s);
      await presenting(p, token(staff, s));
      check("owned by that role, it sees the session through RLS — and its end", [yes, await isAdmin(p)], [true, false]);
      await asRoot(p);
      check("refuses to run twice (is_admin no longer the 0062 definition)",
        /not the 0062 definition/.test(await apply(p, "migrator_sess")), true);
      await p.end();
    }
    {
      // An owner that cannot see the rows would lock every admin out.
      await engine.database("sesslock", "0066");
      const p = await engine.connect("sesslock");
      await handToOwner(p, "sesslock", "migrator_nobypass");
      await p.query("grant select on auth.sessions to migrator_nobypass");
      const err = await apply(p, "migrator_nobypass");
      check("LOCKOUT GUARD: owner without BYPASSRLS on an RLS table → refuses to commit",
        /does not bypass it/.test(err), true);
      await p.query("revoke select on auth.sessions from migrator_nobypass; alter role migrator_nobypass bypassrls");
      check("LOCKOUT GUARD: owner without SELECT on auth.sessions → refuses to commit",
        /cannot SELECT auth.sessions/.test(await apply(p, "migrator_nobypass")), true);
      const unchanged = (await p.query("select md5(prosrc) m from pg_proc where oid = 'public.is_admin()'::regprocedure")).rows[0].m;
      check("…and is_admin() is left exactly as 0062 wrote it", unchanged, "96516dcb5f2713b12f88babedf9094c9");
      await p.query("create or replace function public.is_admin() returns boolean language sql security definer stable set search_path = public, pg_temp as $f$ select true $f$");
      check("refuses to replace an is_admin() it does not recognise",
        /not the 0062 definition/.test(await apply(p, "postgres")), true);
      await p.end();
    }
    {
      await engine.database("sessleak", "0066");
      const p = await engine.connect("sessleak");
      await p.query("grant select on auth.sessions to authenticated");
      check("refuses to commit if an API role can read auth.sessions",
        /API role can read auth.sessions/.test(await apply(p, "postgres")), true);
      await p.end();
    }

    // ── 5. The application ends sessions at Supabase ──
    console.log("\n=== the application ends the session where the database can see it ===");
    const read = (f: string) => fs.readFileSync(f, "utf8");
    const mw = read("middleware.ts");
    const gate = read("lib/adminApiGate.ts");
    const route = read("app/api/admin/session/route.ts");
    const client = read("lib/adminSessionClient.ts");
    check("sign-out: the browser revokes at Supabase (global for Sign out, local for timeout)",
      /auth\.signOut\(\{ scope: reason === "timeout" \? "local" : "global" \}\)/.test(client), true);
    check("sign-out: the session endpoint revokes whatever is left", /DELETE[\s\S]*signOut\(\{ scope: "local" \}\)/.test(route), true);
    check("idle expiry in middleware revokes at Supabase", /activity === "expired"[\s\S]{0,400}signOut\(\{ scope: "local" \}\)/.test(mw), true);
    check("idle expiry at the admin API gate revokes at Supabase", /activity === "expired"[\s\S]{0,200}signOut\(\{ scope: "local" \}\)/.test(gate), true);
    check("idle expiry at the heartbeat revokes at Supabase", /activity === "expired"[\s\S]{0,200}signOut\(\{ scope: "local" \}\)/.test(route), true);
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

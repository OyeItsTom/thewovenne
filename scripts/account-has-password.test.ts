/**
 * 0072 — account_has_password(): true/false for the CALLER's own account only.
 *
 * Settings needs to know whether the signed-in customer has a password. The
 * identities list cannot say: on 17 Oct 2026 a Google-only customer set a
 * password through the recovery link and Supabase Auth added no `email`
 * identity. auth.users.encrypted_password is what Auth itself checks, and no
 * API role can read it. This proves the function that reads it for them:
 *
 *   1. the answers: password account, Google-only ('' and NULL), the same
 *      Google-only account after it sets a password, staff at aal1 and aal2;
 *   2. it answers only about the caller, and only for a live session: anon is
 *      refused; no argument can name anyone; a token naming another user's
 *      session, a signed-out session, an expired one, a missing or malformed
 *      session_id — all NULL, never another account's state;
 *   3. it writes nothing and returns nothing but a boolean;
 *   4. applied as production applies it — one transaction, a non-superuser
 *      owner shaped like Supabase's postgres — and its guards refuse an owner
 *      that cannot see the rows, a column an API role could read, and a second run.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/account-has-password.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import fs from "node:fs";
import { asRoot, asUser, failure, handToOwner, makeAdmin, startEngine, type Client } from "./pg-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const MIGRATION = "supabase/migrations/0072_account_has_password.sql";
const HASH = "$2a$10$abcdefghijklmnopqrstuuJ0Hd1mXz0m3Z9tQm6rQnV2cJ8mT9h7e";

async function user(c: Client, email: string, password: string | null): Promise<string> {
  await asRoot(c);
  const id = (await c.query("insert into auth.users (email, encrypted_password) values ($1, $2) returning id", [email, password])).rows[0].id as string;
  await c.query("insert into profiles (id, email) values ($1, $2) on conflict (id) do nothing", [id, email]);
  return id;
}

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

async function ask(c: Client): Promise<boolean | null | string> {
  try {
    return (await c.query("select public.account_has_password() a")).rows[0].a as boolean | null;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);

  try {
    console.log("\n=== clean replay, every migration ===");
    await engine.database("pwnew");
    const c = await engine.connect("pwnew");
    check("clean replay applies every migration, 0072's self-check included", true, true);

    const pw = await user(c, "password@example.test", HASH);
    const google = await user(c, "google@example.test", null);
    const googleEmpty = await user(c, "google-empty@example.test", "");
    const staff = await makeAdmin(c, "staff@example.test");
    await c.query("update auth.users set encrypted_password = $1 where id = $2", [HASH, staff]);

    // ── 1. The answers ──
    console.log("\n=== the answers ===");
    await asUser(c, pw, "aal1");
    check("password account → true", await ask(c), true);
    await asUser(c, google, "aal1");
    check("Google-only account (no hash) → false", await ask(c), false);
    await asUser(c, googleEmpty, "aal1");
    check("Google-only account (empty hash, as Auth writes it) → false", await ask(c), false);

    const gSession = await newSession(c, google, "aal1");
    await presenting(c, { sub: google, aal: "aal1", session_id: gSession });
    check("Google-only, before setting a password → false", await ask(c), false);
    await asRoot(c);
    // What Supabase Auth's updateUser({ password }) does: writes the hash, adds no identity.
    await c.query("update auth.users set encrypted_password = $1 where id = $2", [HASH, google]);
    await presenting(c, { sub: google, aal: "aal1", session_id: gSession });
    check("same Google account, same session, after setting a password → true", await ask(c), true);

    await asUser(c, staff, "aal1");
    check("staff at aal1 → only its own boolean", await ask(c), true);
    await asUser(c, staff, "aal2");
    check("staff at aal2 → only its own boolean", await ask(c), true);

    // ── 2. Only the caller, only a live session ──
    console.log("\n=== only the caller, only while the session is live ===");
    await asRoot(c);
    await c.query("set role anon");
    await c.query("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "anon" })]);
    check("anon cannot execute it", /permission denied/.test(await failure(() => c.query("select public.account_has_password()"))), true);
    await asRoot(c);
    await c.query("set role anon");
    await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "anon", sub: pw })]);
    check("anon with a forged sub still cannot execute it", /permission denied/.test(await failure(() => c.query("select public.account_has_password()"))), true);

    await asUser(c, googleEmpty, "aal1");
    check("no argument can name another account", /does not exist/.test(await failure(() => c.query("select public.account_has_password($1::uuid)", [pw]))), true);
    check("…the Google-only caller still gets its own false, not the password account's true", await ask(c), false);

    const pwSession = await newSession(c, pw, "aal1");
    await presenting(c, { sub: googleEmpty, aal: "aal1", session_id: pwSession });
    check("a token naming ANOTHER user's live session → NULL", await ask(c), null);
    await presenting(c, { sub: pw, aal: "aal1", session_id: (await newSession(c, googleEmpty, "aal1")) });
    check("sub of a password user + someone else's session → NULL", await ask(c), null);

    const ending = await newSession(c, pw, "aal1");
    await presenting(c, { sub: pw, aal: "aal1", session_id: ending });
    const live = await ask(c);
    await asRoot(c);
    await c.query("delete from auth.sessions where id = $1", [ending]);
    await presenting(c, { sub: pw, aal: "aal1", session_id: ending });
    check("signed out (session deleted): live → true, then the copied token → NULL", [live, await ask(c)], [true, null]);
    await presenting(c, { sub: pw, aal: "aal1", session_id: await newSession(c, pw, "aal1", "2000-01-01T00:00:00Z") });
    check("session past not_after → NULL", await ask(c), null);
    await presenting(c, { sub: pw, aal: "aal1" });
    check("no session_id claim → NULL", await ask(c), null);
    await presenting(c, { sub: pw, aal: "aal1", session_id: "not-a-uuid" });
    check("malformed session_id → NULL, not an error", await ask(c), null);
    await presenting(c, { sub: "00000000-0000-0000-0000-000000000000", aal: "aal1", session_id: pwSession });
    check("unknown user → NULL", await ask(c), null);

    // ── 3. Reads only, answers only a boolean ──
    console.log("\n=== reads only ===");
    await asRoot(c);
    const fn = (await c.query(`select provolatile, prosecdef, pronargs, prorettype::regtype::text rt, proconfig,
        prosrc ~* '\\m(insert|update|delete|truncate|merge|alter|grant|create)\\M' writes,
        has_function_privilege('anon', oid, 'EXECUTE') anon_x, has_function_privilege('authenticated', oid, 'EXECUTE') auth_x
        from pg_proc where oid = 'public.account_has_password()'::regprocedure`)).rows[0];
    check("STABLE, SECURITY DEFINER, no arguments, returns boolean", [fn.provolatile, fn.prosecdef, fn.pronargs, fn.rt], ["s", true, 0, "boolean"]);
    check("search_path pinned to public, pg_temp", fn.proconfig, ["search_path=public, pg_temp"]);
    check("its body contains no write", fn.writes, false);
    check("EXECUTE: authenticated yes, anon no", [fn.auth_x, fn.anon_x], [true, false]);
    await asUser(c, pw, "aal1");
    await c.query("begin read only");
    check("answers inside a READ ONLY transaction", await ask(c), true);
    await c.query("rollback");
    await asUser(c, pw, "aal1");
    check("authenticated still cannot read the password column itself",
      /permission denied/.test(await failure(() => c.query("select encrypted_password from auth.users"))), true);
    await asRoot(c);
    await c.end();

    // ── 4. As production applies it ──
    console.log("\n=== 0072 applied as production applies it ===");
    const apply = async (cl: Client, role: string, sql = fs.readFileSync(MIGRATION, "utf8")) => {
      await cl.query("begin");
      try { await cl.query(`set local role ${role}`); await cl.query(sql); await cl.query("commit"); return ""; }
      catch (e) { await cl.query("rollback"); return (e as Error).message; }
    };
    {
      // Like Supabase's postgres: not a superuser, BYPASSRLS, SELECT on auth.users and auth.sessions,
      // with RLS on both tables as production has it.
      await engine.database("pwprod", "0071");
      const p = await engine.connect("pwprod");
      await handToOwner(p, "pwprod", "migrator_pw");
      await p.query("alter role migrator_pw bypassrls; grant select on auth.sessions to migrator_pw");
      await p.query("alter table auth.users enable row level security");
      check("applies in one transaction as a non-superuser owner, self-check included", await apply(p, "migrator_pw"), "");
      const u = await user(p, "prod-google@example.test", null);
      const s = await newSession(p, u, "aal1");
      await presenting(p, { sub: u, aal: "aal1", session_id: s });
      const before = await ask(p);
      await asRoot(p);
      await p.query("update auth.users set encrypted_password = $1 where id = $2", [HASH, u]);
      await presenting(p, { sub: u, aal: "aal1", session_id: s });
      check("owned by that role, it reads through RLS: Google-only false → password set true", [before, await ask(p)], [false, true]);
      await asRoot(p);
      check("refuses to run twice", /already exists/.test(await apply(p, "migrator_pw")), true);
      await p.end();
    }
    {
      await engine.database("pwlock", "0071");
      const p = await engine.connect("pwlock");
      await handToOwner(p, "pwlock", "migrator_pwnob");
      await p.query("grant select on auth.sessions to migrator_pwnob");
      await p.query("alter table auth.users enable row level security");
      check("guard: owner without BYPASSRLS on an RLS table → refuses to commit",
        /does not bypass it/.test(await apply(p, "migrator_pwnob")), true);
      await p.query("alter role migrator_pwnob bypassrls; revoke select on auth.sessions from migrator_pwnob");
      check("guard: owner that cannot read auth.sessions → refuses to commit",
        /cannot read auth.users \/ auth.sessions/.test(await apply(p, "migrator_pwnob")), true);
      check("…and nothing was created", (await p.query("select to_regprocedure('public.account_has_password()') is null n")).rows[0].n, true);
      await p.end();
    }
    {
      await engine.database("pwleak", "0071");
      const p = await engine.connect("pwleak");
      await p.query("grant select (encrypted_password) on auth.users to authenticated");
      check("guard: refuses if an API role can read the password column",
        /API role can read auth.users.encrypted_password/.test(await apply(p, "postgres")), true);
      await p.end();
    }
  } finally {
    await engine.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

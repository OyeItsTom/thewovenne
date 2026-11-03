/**
 * scripts/run-migration.mjs and the shared target rule (scripts/lib/db-target.mjs),
 * exercised as the release runbook uses them: the real runner, spawned as a
 * separate process, against real PostgreSQL 17.6 (embedded, via pg-world).
 *
 *   PG_HARNESS_DIR=<dir with embedded-postgres@17.6.0-beta.15> npx tsx scripts/run-migration.test.ts
 *
 * Never reads this repository's .env.local and never inherits the caller's
 * environment: every run gets a fixture checkout in a temp directory, its own
 * .env.local naming a local database with a throwaway password, and an
 * environment built from nothing but PATH and HOME (plus NODE_OPTIONS for a
 * network guard, and whatever a case adds on purpose). Without the harness the suite reports SKIPPED (exit 2), never
 * passed.
 *
 *   A. Order and results: in order → 0; re-run → 3 and nothing changed; gaps
 *      and out-of-order → 2 and nothing changed; a failing file → 1, rolled
 *      back, no ledger row; --force rules.
 *   B. Ledger states: the 0057 legacy start, no ledger, foreign or malformed rows.
 *   C. The checkout: files outside supabase/migrations/, bad names, duplicate numbers.
 *   D. The target: hostile shell and libpq variables, duplicate or tampered
 *      .env.local, --expect-host, and that no credential is ever printed.
 *   E. security-posture.ts --production under the same rule (read-only).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startEngine, type Client } from "./pg-world";

const ROOT = path.join(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const RUNNER = path.join(__dirname, "run-migration.mjs");
const POSTURE = path.join(__dirname, "security-posture.ts");
const PASSWORD = "throwaway"; // pg-world's; asserted never to appear in any output

let pass = 0;
let fail = 0;
// Exit with process.exit(), never process.exitCode: embedded-postgres's exit
// hook (async-exit-hook) calls process.exit(0) on beforeExit, which silently
// replaces a failing exitCode with 0.
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail.slice(0, 900)}`}`);
};

const real = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const max = Number(real[real.length - 1].slice(0, 4));
const num = (n: number) => String(n).padStart(4, "0");
// Three fixture migrations above whatever main holds today (never pinned).
const F1 = `${num(max + 1)}_fixture_alpha.sql`;
const F2 = `${num(max + 2)}_fixture_beta.sql`;
const F3 = `${num(max + 3)}_fixture_gamma.sql`;
const fixtureSql = (tbl: string) => `create table public.${tbl} (id int);\ninsert into public.${tbl} values (1);\nselect '${tbl}' as verify, count(*)::int as rows from public.${tbl};\n`;

/** A checkout: the real migration files plus fixture ones, in a temp dir. */
function checkout(extra: Record<string, string>, drop: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runmig-"));
  const m = path.join(dir, "supabase", "migrations");
  fs.mkdirSync(m, { recursive: true });
  for (const f of real) if (!drop.includes(f)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(m, f));
  for (const [f, body] of Object.entries(extra)) fs.writeFileSync(path.join(m, f), body);
  // security-posture.ts reads its manifest relative to the working directory.
  fs.copyFileSync(path.join(ROOT, "supabase", "security-posture.json"), path.join(dir, "supabase", "security-posture.json"));
  return dir;
}

const outputs: string[] = [];
type Run = { code: number; out: string };
function spawn(cmd: string, argv: string[], cwd: string, env: Record<string, string>): Run {
  const r = spawnSync(cmd, argv, {
    cwd, encoding: "utf8", timeout: 120000,
    // Nothing inherited but PATH and HOME, plus NODE_OPTIONS and A3_NETGUARD_LOG
    // so a harness can put a network guard on the runners too.
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
      ...(process.env.A3_NETGUARD_LOG ? { A3_NETGUARD_LOG: process.env.A3_NETGUARD_LOG } : {}),
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  outputs.push(out);
  return { code: r.status ?? -1, out };
}

let port = 0;
const urlFor = (db: string, q = "?sslmode=disable") => `postgresql://postgres:${PASSWORD}@localhost:${port}/${db}${q}`;

/** Run the real runner from `ck` against `db`. `envFile` overrides .env.local's whole content (null = no file). */
function mig(ck: string, db: string, args: string[], opts: { env?: Record<string, string>; envFile?: string | null } = {}): Run {
  const envPath = path.join(ck, ".env.local");
  fs.rmSync(envPath, { force: true });
  if (opts.envFile !== null) fs.writeFileSync(envPath, opts.envFile ?? `SUPABASE_DB_URL=${urlFor(db)}\n`);
  return spawn(process.execPath, [RUNNER, ...args], ck, opts.env ?? {});
}
const EH = ["--expect-host", "localhost"];

(async () => {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED: embedded-postgres not found. Set PG_HARNESS_DIR.");
    process.exit(2);
  }
  console.log(`${engine.version.split(" on ")[0]} | checkout migrations 0001–${num(max)} | fixtures ${F1}, ${F2}, ${F3}`);

  // ── base: a clean replay of every migration, ledger as the runner leaves it ──
  await engine.database("base");
  {
    const c = await engine.connect("base");
    port = (c as unknown as { connectionParameters: { port: number } }).connectionParameters.port;
    for (const f of real.filter((f) => Number(f.slice(0, 4)) >= 57)) {
      await c.query(`insert into schema_migrations (filename, applied_at, recorded_retrospectively) values ($1, now(), false)
                     on conflict (filename) do update set applied_at = excluded.applied_at, recorded_retrospectively = false`, [f]);
    }
    await c.end();
  }
  // a database before 0057: no ledger
  await engine.database("pre57", "0056");
  // a database with no Wovenne tables at all
  const root = await engine.connect("postgres");
  await root.query("create database empty");
  const clone = async (name: string, from = "base") => {
    await root.query(`drop database if exists ${name}`);
    await root.query(`create database ${name} template ${from}`);
  };
  const open = async <T,>(db: string, fn: (c: Client) => Promise<T>): Promise<T> => {
    const c = await engine.connect(db);
    try { return await fn(c); } finally { await c.end(); }
  };
  const fingerprint = (db: string): Promise<string> => open(db, async (c) => JSON.stringify([
    (await c.query("select filename, applied_at, recorded_retrospectively from schema_migrations order by 1")).rows,
    (await c.query("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1")).rows,
  ]));
  const ledgerHas = (db: string, f: string) =>
    open(db, async (c) => (await c.query("select applied_at from schema_migrations where filename = $1", [f])).rows[0]?.applied_at ?? null);
  const tableExists = (db: string, tbl: string) =>
    open(db, async (c) => (await c.query("select to_regclass($1) is not null ok", [`public.${tbl}`])).rows[0].ok as boolean);

  const good = checkout({ [F1]: fixtureSql("fixture_alpha"), [F2]: fixtureSql("fixture_beta"), [F3]: fixtureSql("fixture_gamma") });
  const m = (f: string) => `supabase/migrations/${f}`;

  try {
    console.log("\n=== A. order and results ===");
    await clone("a1");
    let r = mig(good, "a1", [m(F1), ...EH]);
    t("in-order apply → exit 0", r.code === 0, r.out);
    t("…prints the target before anything else, without credentials", /^target: host=localhost port=\d+ database=a1 project_ref=n\/a$/m.test(r.out.split("\n")[0]), r.out.split("\n")[0]);
    t("…prints applied + recorded + the verify block", /applied .* — recorded in schema_migrations at /.test(r.out) && /fixture_alpha/.test(r.out) && /│|\bverify\b/.test(r.out), r.out);
    t("…ledger row with a real applied_at; the table exists", (await ledgerHas("a1", F1)) !== null && (await tableExists("a1", "fixture_alpha")));

    let before = await fingerprint("a1");
    r = mig(good, "a1", [m(F1), ...EH]);
    t("re-run → exit 3 and NOTHING APPLIED", r.code === 3 && /NOTHING APPLIED/.test(r.out), `${r.code} ${r.out}`);
    t("…nothing changed (fingerprint)", (await fingerprint("a1")) === before);

    before = await fingerprint("a1");
    r = mig(good, "a1", [m(F3), ...EH]);
    t(`gap (${F3} with ${F2} missing) → exit 2, names the missing file`, r.code === 2 && r.out.includes(F2) && /out of order/.test(r.out), `${r.code} ${r.out}`);
    t("…nothing changed", (await fingerprint("a1")) === before);

    await clone("a2");
    before = await fingerprint("a2");
    r = mig(good, "a2", [m(F2), ...EH]);
    t(`gap on a ${num(max)} database (${F2} without ${F1}) → exit 2`, r.code === 2 && r.out.includes(F1), `${r.code} ${r.out}`);
    t("…nothing changed", (await fingerprint("a2")) === before);

    // A later migration recorded while an earlier one is not (e.g. applied by hand).
    await clone("a3");
    await open("a3", (c) => c.query("insert into schema_migrations (filename, applied_at) values ($1, now())", [F2]));
    before = await fingerprint("a3");
    r = mig(good, "a3", [m(F1), ...EH]);
    t("earlier file after a later one is recorded → exit 2 (out of order)", r.code === 2 && /later migrations/.test(r.out) && r.out.includes(F2), `${r.code} ${r.out}`);
    t("…nothing changed", (await fingerprint("a3")) === before);

    await clone("a4");
    const failing = checkout({ [F1]: "create table public.fixture_half (id int);\ninsert into public.fixture_half values (1);\nselect 1/0;\n" });
    r = mig(failing, "a4", [m(F1), ...EH]);
    t("a file that fails halfway → exit 1, FAILED — rolled back", r.code === 1 && /FAILED — rolled back/.test(r.out) && /division by zero/.test(r.out), `${r.code} ${r.out}`);
    t("…no table from its first half, no ledger row", !(await tableExists("a4", "fixture_half")) && (await ledgerHas("a4", F1)) === null);

    // --force
    const forceCk = checkout({ [F1]: "create table if not exists public.fixture_alpha (id int);\nselect 'again' as verify;\n", [F2]: fixtureSql("fixture_beta") });
    await clone("a5", "a1");
    r = mig(forceCk, "a5", [m(F1), ...EH, "--force"]);
    t("--force re-run of the newest → exit 0, logged as FORCED RE-RUN", r.code === 0 && /WARNING: --force — RE-RUNNING/.test(r.out) && /FORCED RE-RUN/.test(r.out), `${r.code} ${r.out}`);
    r = mig(forceCk, "a5", [m(F2), ...EH]);
    t("…then the next file in order → exit 0", r.code === 0, r.out);
    before = await fingerprint("a5");
    r = mig(forceCk, "a5", [m(F1), ...EH, "--force"]);
    t("--force re-run of an earlier file once a later one is recorded → exit 2", r.code === 2 && /later migrations/.test(r.out), `${r.code} ${r.out}`);
    t("…nothing changed", (await fingerprint("a5")) === before);
    r = mig(good, "a2", [m(F1), ...EH, "--force"]);
    t("--force on a file not yet applied → applies normally (exit 0) and says it had no effect", r.code === 0 && /--force had no effect/.test(r.out), r.out);

    console.log("\n=== B. ledger states ===");
    // The legacy start, as a new project is built: 0001–0056 by hand, then 0057, 0058 by the runner.
    const f57 = real.find((f) => f.startsWith("0057"))!;
    const f58 = real.find((f) => f.startsWith("0058"))!;
    const f59 = real.find((f) => f.startsWith("0059"))!;
    const f60 = real.find((f) => f.startsWith("0060"))!;
    await clone("b1", "pre57");
    r = mig(good, "b1", [m(f58), ...EH]);
    t("no ledger + a file after 0057 → exit 2 (0057 not applied)", r.code === 2 && /0057_migration_ledger.sql has not been applied/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "b1", [m(real[0]), ...EH]);
    t("no ledger + a file before 0057 → exit 2 (cannot be recorded; use psql)", r.code === 2 && /cannot be recorded/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "b1", [m(f57), ...EH]);
    t("0057 onto a 0056 database (legacy start) → exit 0", r.code === 0, r.out);
    const legacy = await open("b1", async (c) => (await c.query("select count(*) filter (where recorded_retrospectively)::int retro, count(*) filter (where filename = $1 and applied_at is not null)::int own from schema_migrations", [f57])).rows[0]);
    t("…backfilled rows recorded retrospectively, 0057 itself with a real time", legacy.retro > 0 && legacy.own === 1, JSON.stringify(legacy));
    r = mig(good, "b1", [m(f58), ...EH]);
    t("…then 0058 → exit 0 (gaps before 0057 are the accepted legacy start)", r.code === 0, r.out);
    r = mig(good, "b1", [m(f60), ...EH]);
    t("…then 0060 skipping 0059 → exit 2, names 0059", r.code === 2 && r.out.includes(f59), `${r.code} ${r.out}`);
    r = mig(good, "empty", [m(f57), ...EH]);
    t("0057 onto a database with no Wovenne tables → exit 2", r.code === 2 && /no Wovenne tables/.test(r.out), `${r.code} ${r.out}`);

    await clone("b2");
    await open("b2", (c) => c.query("insert into schema_migrations (filename, recorded_retrospectively) values ('0018_not_in_this_checkout.sql', true)"));
    before = await fingerprint("b2");
    r = mig(good, "b2", [m(F1), ...EH]);
    t("a ledger row naming a file this checkout lacks → exit 2 (stale checkout / wrong DB)", r.code === 2 && /unexpected ledger state/.test(r.out) && /0018_not_in_this_checkout/.test(r.out), `${r.code} ${r.out}`);
    t("…nothing changed", (await fingerprint("b2")) === before);
    await clone("b3");
    await open("b3", (c) => c.query(`update schema_migrations set applied_at = null where filename = $1`, [f58]));
    r = mig(good, "b3", [m(F1), ...EH]);
    t("a ledger row with neither applied_at nor retrospective → exit 2", r.code === 2 && /neither applied_at nor recorded_retrospectively/.test(r.out), `${r.code} ${r.out}`);
    await clone("b4");
    await open("b4", (c) => c.query("insert into schema_migrations (filename, recorded_retrospectively) values ('notes.txt', true)"));
    r = mig(good, "b4", [m(F1), ...EH]);
    t("a malformed ledger filename → exit 2", r.code === 2 && /unexpected filename/.test(r.out), `${r.code} ${r.out}`);
    const ahead = checkout({ [F1]: fixtureSql("fixture_alpha") });
    await clone("b5");
    await open("b5", (c) => c.query("insert into schema_migrations (filename, applied_at) values ($1, now())", [F2]));
    r = mig(ahead, "b5", [m(F1), ...EH]);
    t("the database is ahead of this checkout (ledger has a newer file) → exit 2", r.code === 2 && /does not have/.test(r.out) && r.out.includes(F2), `${r.code} ${r.out}`);

    console.log("\n=== C. the checkout ===");
    const stray = path.join(good, "stray.sql");
    fs.writeFileSync(stray, fixtureSql("fixture_stray"));
    r = mig(good, "a2", ["stray.sql", ...EH]);
    t("a file outside supabase/migrations/ → exit 2", r.code === 2 && /not in this checkout's supabase\/migrations/.test(r.out), `${r.code} ${r.out}`);
    const dup = checkout({ [F1]: fixtureSql("fixture_alpha"), [`${num(max + 1)}_fixture_twin.sql`]: fixtureSql("fixture_twin") });
    r = mig(dup, "a2", [m(F1), ...EH]);
    t("two files share a number → exit 2", r.code === 2 && /share number/.test(r.out), `${r.code} ${r.out}`);
    const badName = checkout({ [`${num(max + 1)}-Fixture.sql`]: "select 1;" });
    r = mig(badName, "a2", [m(`${num(max + 1)}-Fixture.sql`), ...EH]);
    t("a badly named file → exit 2", r.code === 2 && /not named NNNN_name.sql/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "a2", [m(F1), ...EH, "--froce"]);
    t("an unknown option → exit 2", r.code === 2 && /unknown option/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "a2", []);
    t("no file → exit 2 (usage)", r.code === 2 && /usage/.test(r.out), `${r.code} ${r.out}`);

    console.log("\n=== D. the target ===");
    await clone("d1");
    before = await fingerprint("d1");
    const hostile = `postgresql://postgres:hostile-secret@hostile.example.invalid:5432/postgres`;
    r = mig(good, "d1", [m(F1)]);
    t("no --expect-host → exit 2, before connecting", r.code === 2 && /--expect-host <host> is required/.test(r.out) && !/ECONN|ENOTFOUND/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), "--expect-host", "db.wrongref.supabase.co"]);
    t("wrong --expect-host → exit 2, names both hosts and the target", r.code === 2 && /host is localhost, expected db.wrongref.supabase.co\. \(target: host=localhost/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), "--expect-host"]);
    t("--expect-host with no value → exit 2", r.code === 2 && /needs a host/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), ...EH], { env: { SUPABASE_DB_URL: hostile } });
    t("hostile exported SUPABASE_DB_URL differing from .env.local → exit 2", r.code === 2 && /differs from .env.local/.test(r.out) && !/ENOTFOUND/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), "--expect-host", "hostile.example.invalid"], { env: { SUPABASE_DB_URL: hostile }, envFile: null });
    t("the shell URL alone (no .env.local) → exit 2, even with a matching --expect-host", r.code === 2 && /does not exist/.test(r.out) && !/ENOTFOUND/.test(r.out), `${r.code} ${r.out}`);
    for (const v of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGOPTIONS", "PGSSLMODE", "PGSERVICE"]) {
      r = mig(good, "d1", [m(F1), ...EH], { env: { [v]: v === "PGPORT" ? "1" : v === "PGOPTIONS" ? "-c search_path=evil" : "hostile.example.invalid" } });
      t(`inherited ${v} → exit 2`, r.code === 2 && r.out.includes(v), `${r.code} ${r.out}`);
    }
    r = mig(good, "d1", [m(F1), ...EH], { envFile: `SUPABASE_DB_URL=${urlFor("d1")}\nSUPABASE_DB_URL=${hostile}\n` });
    t(".env.local defining SUPABASE_DB_URL twice → exit 2", r.code === 2 && /defined 2 times/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), ...EH], { envFile: `SUPABASE_DB_URL=${urlFor("d1", "?host=hostile.example.invalid")}\n` });
    t("a ?host= override hidden in the URL → exit 2", r.code === 2 && /query parameters \(host\)/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), ...EH], { envFile: `SUPABASE_DB_URL=${urlFor("d1", "?sslmode=disable&options=-c%20search_path%3Devil")}\n` });
    t("an ?options= session override → exit 2", r.code === 2 && /query parameters \(options\)/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), "--expect-host", "hostile.example.invalid"], { envFile: `SUPABASE_DB_URL=postgresql://postgres:hostile-secret@hostile.example.invalid:5432/postgres?sslmode=disable\n` });
    t("sslmode=disable for a non-loopback host → exit 2", r.code === 2 && /only allowed for a loopback/.test(r.out), `${r.code} ${r.out}`);
    r = mig(good, "d1", [m(F1), ...EH], { envFile: `SUPABASE_DB_URL=postgresql://postgres:bad%zzpassword@localhost:${port}/d1?sslmode=disable\n` });
    t("a password that is not valid percent-encoding → exit 2, a clean refusal", r.code === 2 && /not valid percent-encoding/.test(r.out) && !/URIError|bad%zz/.test(r.out), `${r.code} ${r.out}`);
    t("…none of the refused runs changed the database", (await fingerprint("d1")) === before);
    r = mig(good, "d1", [m(F1), ...EH], { env: { SUPABASE_DB_URL: urlFor("d1") } });
    t("an exported SUPABASE_DB_URL identical to .env.local → allowed (exit 0)", r.code === 0, r.out);
    r = mig(good, "d1", [m(F2), "--expect-host", "LOCALHOST"]);
    t("--expect-host compares hostnames case-insensitively (exit 0)", r.code === 0, r.out);

    console.log("\n=== E. security-posture.ts --production (read-only) ===");
    const runPosture = (db: string, args: string[], opts: { env?: Record<string, string>; envFile?: string } = {}) => {
      fs.writeFileSync(path.join(good, ".env.local"), opts.envFile ?? `SUPABASE_DB_URL=${urlFor(db)}\n`);
      // Re-uses this process's tsx loader, so the .ts file runs as the runbook runs it.
      return spawn(process.execPath, [...process.execArgv, POSTURE, "--production", ...args], good, opts.env ?? {});
    };
    await clone("e1");
    r = runPosture("e1", []);
    t("posture of a clean replay → prints the target first, MATCHES, exit 0", r.code === 0 && /^target: host=localhost port=\d+ database=e1/m.test(r.out) && /MATCHES/.test(r.out), r.out.slice(-600));
    r = runPosture("e1", ["--expect-host", "localhost"]);
    t("…with a matching --expect-host → exit 0", r.code === 0 && /MATCHES/.test(r.out), r.out.slice(-400));
    r = runPosture("e1", ["--expect-host", "db.wrongref.supabase.co"]);
    t("…with a wrong --expect-host → exit 2, before connecting", r.code === 2 && /host is localhost, expected/.test(r.out), `${r.code} ${r.out}`);
    r = runPosture("e1", [], { env: { SUPABASE_DB_URL: hostile } });
    t("…with a hostile exported SUPABASE_DB_URL → exit 2", r.code === 2 && /differs from .env.local/.test(r.out), `${r.code} ${r.out}`);
    r = runPosture("e1", [], { env: { PGHOST: "hostile.example.invalid" } });
    t("…with an inherited PGHOST → exit 2", r.code === 2 && /PGHOST/.test(r.out), `${r.code} ${r.out}`);

    console.log("\n=== credentials ===");
    const leaked = outputs.filter((o) => o.includes(PASSWORD) || o.includes("hostile-secret"));
    t(`no output of ${outputs.length} runs contains a password`, leaked.length === 0, leaked[0]);
  } catch (e) {
    t("suite ran to completion", false, (e as Error).stack ?? String(e));
  } finally {
    await root.end();
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 && pass > 0 ? 0 : 1);
})().catch((e) => {
  console.log(`  ERROR  ${(e as Error).stack ?? e}`);
  process.exit(1);
});

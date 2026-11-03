#!/usr/bin/env node
/**
 * Run ONE recovery SQL file (supabase/recovery/*.sql) against ONE database.
 *
 *   node scripts/run-recovery-sql.mjs supabase/recovery/0076_rollback.sql \
 *     --expect-host <host> --i-have-a-verified-backup
 *
 * Procedures, order and preconditions: supabase/recovery/README.md.
 *
 * NOT the migration runner. scripts/run-migration.mjs records every file it
 * applies in schema_migrations; a rollback must not be recorded as a migration.
 * The SQL file carries its own BEGIN/COMMIT, guards and self-check. This
 * script only:
 *   - takes the connection by the shared target rule (scripts/lib/db-target.mjs):
 *     SUPABASE_DB_URL from ./.env.local only, the same database
 *     run-migration.mjs uses; a differing exported SUPABASE_DB_URL, inherited
 *     PG* variables or URL query overrides are refused; host, port, database
 *     and project ref are printed before connecting;
 *   - refuses unless --expect-host matches that host exactly, so a rollback
 *     meant for a rehearsal cannot reach Production, or the reverse;
 *   - refuses without --i-have-a-verified-backup (runbook R0 step 3);
 *   - runs only its own NNNN_rollback.sql files from the supabase/recovery/
 *     next to it, so no migration can bypass run-migration.mjs's ledger and
 *     order checks through here; unknown options are refused;
 *   - on any error, issues ROLLBACK, prints the database's message and exits 1.
 *     The file's guards guarantee nothing changed in that case.
 *
 * It never prints the connection string or the password.
 *
 * Exit codes: 0 completed; 1 failed and rolled back (including a guard's
 * refusal inside the SQL); 2 refused before connecting, nothing ran.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { TargetRefused, expectHostArg, resolveTarget } from "./lib/db-target.mjs";

// Exit codes: 0 the file completed; 1 it failed and was rolled back; 2 refused
// before connecting (usage, file, target), nothing ran.
const KNOWN_FLAGS = new Set(["--expect-host", "--i-have-a-verified-backup"]);
// Only this runner's own reviewed recovery files: a migration (or any other
// .sql) run through here would bypass the migration runner's ledger and order
// checks. Resolved from the script, so a pinned tools checkout runs its own.
const RECOVERY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "recovery");
const NAME = /^\d{4}_rollback\.sql$/;

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}
const USAGE = "usage: node scripts/run-recovery-sql.mjs supabase/recovery/NNNN_rollback.sql --expect-host <host> --i-have-a-verified-backup";

const args = process.argv.slice(2);
let expectHost;
try { expectHost = expectHostArg(args); } catch (e) { fail(e.message); }
const unknown = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
if (unknown.length) fail(`Refusing: unknown option(s) ${unknown.join(" ")}. Nothing ran.`);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--expect-host");
if (positional.length !== 1) fail(USAGE);
const file = positional[0];
const backedUp = args.includes("--i-have-a-verified-backup");

if (!fs.existsSync(file)) fail(`Refusing: ${file} does not exist. Nothing ran.\n${USAGE}`);
if (!NAME.test(path.basename(file)) || !fs.existsSync(RECOVERY_DIR)
    || fs.realpathSync(path.dirname(path.resolve(file))) !== fs.realpathSync(RECOVERY_DIR)) {
  fail(`Refusing: ${file} is not a recovery file of this runner (${RECOVERY_DIR}/NNNN_rollback.sql). Migrations go through run-migration.mjs. Nothing ran.`);
}
if (!expectHost) fail("Refusing: --expect-host <host> is required. Nothing ran.");
if (!backedUp) fail("Refusing: take and verify a backup first, then pass --i-have-a-verified-backup. Nothing ran.");

let target;
try {
  target = resolveTarget({ write: true, expectHost });
} catch (e) {
  if (e instanceof TargetRefused) fail(e.message);
  throw e;
}
console.log(target.line);

const client = new pg.Client(target.clientConfig);
client.on("notice", (n) => console.log(`notice: ${n.message}`));
await client.connect();
try {
  const sql = fs.readFileSync(file, "utf8");
  const res = await client.query(sql);
  const results = Array.isArray(res) ? res : [res];
  const last = results.filter((r) => r.rows && r.rows.length).pop();
  if (last) console.log(JSON.stringify(last.rows, null, 2));
  console.log(`OK: ${path.basename(file)} completed.`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`REFUSED/FAILED: ${e.message}`);
  console.error("The transaction was rolled back; the database is as it was before this run.");
  process.exitCode = 1;
} finally {
  await client.end();
}

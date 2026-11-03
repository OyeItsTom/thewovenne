/**
 * Apply one migration file to the database named by SUPABASE_DB_URL in .env.local.
 *
 *   node scripts/run-migration.mjs supabase/migrations/0044_whatever.sql --expect-host <host>
 *
 * Runs the whole file in ONE transaction: a migration that fails halfway is
 * the worst outcome available, because everything after it is then written
 * against a schema nobody can describe. Either all of it applies or none does.
 *
 * The trailing verify block every migration carries is a SELECT, so its result
 * is printed rather than discarded — applying a migration and not looking at
 * what it reported is most of the way to not having checked at all.
 *
 * IT RECORDS WHAT IT APPLIED. schema_migrations (0057) gets a row in the SAME
 * transaction as the migration itself, so the ledger cannot claim something that
 * rolled back, and a migration cannot apply without being recorded.
 *
 * THE TARGET follows scripts/lib/db-target.mjs: .env.local only, printed before
 * connecting, --expect-host required and matched exactly.
 *
 * ORDER IS ENFORCED, inside the same transaction and under a lock, against the
 * ledger and this checkout's supabase/migrations/:
 *   - the file must be in this checkout's supabase/migrations/, named NNNN_*.sql,
 *     and no two files there may share a number;
 *   - every ledger row must name a file this checkout has (otherwise the
 *     checkout is stale or the database is not the one you think);
 *   - every file numbered 0057 up to (not including) this one must be in the
 *     ledger, and nothing in the ledger may be numbered at or above it.
 *     Files before 0057 are the legacy start: 0057 recorded those it could
 *     verify, and they are not required again;
 *   - with no ledger yet, only 0057 itself (which creates it) can be applied.
 *
 * Re-running a file already in the ledger is refused rather than repeated: most
 * migrations here are written to be idempotent, but "most" is not a property to
 * bet a production database on at eleven at night. Pass --force to run one anyway;
 * it is logged loudly, and refused if any later migration is already recorded.
 * There is no override for order.
 *
 * EXIT CODES — 0 means exactly one thing:
 *   0  applied, recorded in schema_migrations, committed, verify printed
 *   1  the database refused or the SQL failed: rolled back, nothing applied
 *   2  refused before anything ran (usage, target, order, ledger state)
 *   3  NOTHING APPLIED: the file is already in the ledger
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { TargetRefused, expectHostArg, resolveTarget } from "./lib/db-target.mjs";

const EXIT = { APPLIED: 0, FAILED: 1, REFUSED: 2, ALREADY: 3 };
const LEDGER_START = 57; // 0057_migration_ledger.sql creates the ledger
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const KNOWN_FLAGS = new Set(["--force", "--expect-host"]);

class Refused extends Error {}
class AlreadyApplied extends Error {}

function refuse(msg) {
  console.error(`REFUSED — nothing applied:\n  ${msg}`);
  process.exit(EXIT.REFUSED);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
let expectHost;
try { expectHost = expectHostArg(args); } catch (e) { refuse(e.message); }
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--expect-host");
const unknown = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
if (unknown.length) refuse(`unknown option(s) ${unknown.join(" ")}`);
if (positional.length !== 1) {
  refuse("usage: node scripts/run-migration.mjs <supabase/migrations/NNNN_name.sql> --expect-host <host> [--force]");
}
const file = positional[0];

// ── The file and the checkout, before any connection ──
const migrationsDir = path.resolve("supabase", "migrations");
if (!fs.existsSync(file)) refuse(`${file} does not exist.`);
if (!fs.existsSync(migrationsDir)) refuse(`run from the repository root: ${migrationsDir} does not exist.`);
if (fs.realpathSync(path.dirname(path.resolve(file))) !== fs.realpathSync(migrationsDir)) {
  refuse(`${file} is not in this checkout's supabase/migrations/. Only those files are ordered against the ledger.`);
}
const name = path.basename(file);
const m = NAME.exec(name);
if (!m) refuse(`${name} is not named NNNN_name.sql.`);
const number = Number(m[1]);

const checkout = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
const odd = checkout.filter((f) => !NAME.test(f));
if (odd.length) refuse(`supabase/migrations/ holds files not named NNNN_name.sql: ${odd.join(", ")}`);
const byNumber = new Map();
for (const f of checkout) {
  const n = Number(f.slice(0, 4));
  if (byNumber.has(n)) refuse(`two migrations share number ${f.slice(0, 4)}: ${byNumber.get(n)} and ${f}`);
  byNumber.set(n, f);
}

let target;
try {
  target = resolveTarget({ write: true, expectHost });
} catch (e) {
  if (e instanceof TargetRefused) refuse(e.message);
  throw e;
}
console.log(target.line);
console.log(`file:   ${name}${force ? "  [--force]" : ""}`);

const sql = fs.readFileSync(file, "utf8");
const client = new pg.Client(target.clientConfig);
client.on("notice", (n) => console.log(`notice: ${n.message}`));

/** Every precondition, read inside the transaction after taking the lock. */
async function checkOrder() {
  const ledgerExists = (
    await client.query("select to_regclass('public.schema_migrations') is not null as ok")
  ).rows[0].ok;

  if (!ledgerExists) {
    if (number < LEDGER_START) {
      throw new Refused(`there is no schema_migrations ledger yet, so ${name} cannot be recorded. Apply files before 0057 in order with psql (supabase/README.md), then 0057 with this runner.`);
    }
    if (number > LEDGER_START) {
      throw new Refused(`there is no schema_migrations ledger: 0057_migration_ledger.sql has not been applied, and ${name} comes after it.`);
    }
    if (!(await client.query("select to_regclass('public.products') is not null as ok")).rows[0].ok) {
      throw new Refused("0057 records 0001–0056 as present, but this database has no Wovenne tables (public.products is missing).");
    }
    return { already: null };
  }

  const ledger = (
    await client.query("select filename, applied_at, recorded_retrospectively from schema_migrations order by filename")
  ).rows;

  const problems = [];
  const ledgerNumbers = new Map();
  for (const r of ledger) {
    const lm = NAME.exec(r.filename ?? "");
    if (!lm) { problems.push(`a ledger row has an unexpected filename: ${JSON.stringify(r.filename)}`); continue; }
    const n = Number(lm[1]);
    if (ledgerNumbers.has(n)) problems.push(`the ledger has two rows numbered ${lm[1]}: ${ledgerNumbers.get(n)} and ${r.filename}`);
    ledgerNumbers.set(n, r.filename);
    if (byNumber.get(n) !== r.filename) problems.push(`the ledger records ${r.filename}, which this checkout does not have (stale checkout, or not the database you think)`);
    if (!r.recorded_retrospectively && r.applied_at == null) problems.push(`the ledger row ${r.filename} has neither applied_at nor recorded_retrospectively`);
  }
  if (problems.length) throw new Refused(`unexpected ledger state:\n  - ${problems.join("\n  - ")}`);

  const row = ledger.find((r) => r.filename === name);
  const missing = [...byNumber.entries()]
    .filter(([n]) => n >= LEDGER_START && n < number && !ledgerNumbers.has(n))
    .map(([, f]) => f);
  if (missing.length) {
    throw new Refused(`out of order: ${name} needs these earlier migrations, which are not in the ledger:\n  - ${missing.join("\n  - ")}`);
  }

  const later = [...ledgerNumbers.entries()].filter(([n]) => n > number).map(([, f]) => f);
  if (later.length) {
    throw new Refused(`out of order: the ledger already holds later migrations${row ? " (a --force re-run of an earlier file is refused too)" : ""}:\n  - ${later.join("\n  - ")}`);
  }

  if (row) {
    const when = row.recorded_retrospectively
      ? "recorded retrospectively by 0057 — the schema was verified present, the moment was not"
      : `applied ${row.applied_at?.toISOString?.() ?? row.applied_at}`;
    if (!force) throw new AlreadyApplied(`${name} is already in the ledger (${when}).`);
    return { already: when };
  }

  return { already: null };
}

let committed = false;
try {
  await client.connect();
  await client.query("begin");
  // One runner at a time per database, for the whole check-and-apply.
  await client.query("select pg_advisory_xact_lock(hashtext('wovenne:run-migration'))");

  const { already } = await checkOrder();
  if (already) {
    console.warn(`WARNING: --force — RE-RUNNING ${name}, which is already in the ledger (${already}).`);
  } else if (force) {
    console.warn("note: --force had no effect; this file is not in the ledger yet.");
  }

  const results = await client.query(sql);

  // In the same transaction, deliberately: a ledger that can disagree with the
  // schema is worse than no ledger, because it would be believed.
  await client.query(
    `insert into schema_migrations (filename, applied_at, recorded_retrospectively)
     values ($1, now(), false)
     on conflict (filename) do update
       set applied_at = excluded.applied_at, recorded_retrospectively = false`,
    [name]
  );

  await client.query("commit");
  committed = true;

  const recorded = (await client.query("select applied_at from schema_migrations where filename = $1", [name])).rows[0];
  if (!recorded?.applied_at) throw new Error(`committed, but ${name} is not in schema_migrations afterwards — investigate before anything else`);

  console.log(`applied ${name}${already ? " (FORCED RE-RUN)" : ""} — recorded in schema_migrations at ${recorded.applied_at.toISOString()}`);
  const all = Array.isArray(results) ? results : [results];
  const verify = all.filter((r) => r?.rows?.length);
  for (const r of verify) console.table(r.rows);
  if (verify.length === 0) console.log("(no verify output)");
  process.exitCode = EXIT.APPLIED;
} catch (e) {
  await client.query("rollback").catch(() => {});
  if (e instanceof AlreadyApplied) {
    console.log(e.message);
    console.log("NOTHING APPLIED. Pass --force if you genuinely mean to run it again.");
    process.exitCode = EXIT.ALREADY;
  } else if (e instanceof Refused) {
    console.error(`REFUSED — nothing applied:\n  ${e.message}`);
    process.exitCode = EXIT.REFUSED;
  } else if (committed) {
    console.error(`FAILED AFTER COMMIT — the migration WAS committed; check schema_migrations by hand:\n  ${e.message}`);
    process.exitCode = EXIT.FAILED;
  } else {
    console.error(`FAILED — rolled back, nothing applied:\n  ${e.message}`);
    process.exitCode = EXIT.FAILED;
  }
} finally {
  await client.end().catch(() => {});
}

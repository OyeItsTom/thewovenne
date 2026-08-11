/**
 * Apply one migration file to the database named by SUPABASE_DB_URL.
 *
 *   node scripts/run-migration.mjs supabase/migrations/0044_whatever.sql
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
 * rolled back, and a migration cannot apply without being recorded. Re-running a
 * file already in the ledger is refused rather than repeated: most migrations here
 * are written to be idempotent, but "most" is not a property to bet a production
 * database on at eleven at night. Pass --force to run one anyway.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const args = process.argv.slice(2);
const force = args.includes("--force");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node scripts/run-migration.mjs <path-to-sql> [--force]");
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

if (!env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is not set in .env.local");
  process.exit(1);
}

const sql = fs.readFileSync(file, "utf8");
const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  // The ledger does not exist until 0057 itself has run, so its absence is a
  // normal state rather than an error — checked rather than assumed.
  const ledgerExists = (
    await client.query("select to_regclass('public.schema_migrations') is not null as ok")
  ).rows[0].ok;

  const name = path.basename(file);

  if (ledgerExists && !force) {
    const { rows } = await client.query(
      "select applied_at, recorded_retrospectively from schema_migrations where filename = $1",
      [name]
    );
    if (rows.length > 0) {
      const when = rows[0].recorded_retrospectively
        ? "recorded retrospectively by 0057 — the schema was verified present, the moment was not"
        : `applied ${rows[0].applied_at?.toISOString?.() ?? rows[0].applied_at}`;
      console.log(`${name} is already in the ledger (${when}).`);
      console.log("Nothing was run. Pass --force if you genuinely mean to run it again.");
      process.exit(0);
    }
  }

  await client.query("begin");
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

  console.log(`applied ${file}${force ? " (forced)" : ""} — recorded in schema_migrations`);
  const all = Array.isArray(results) ? results : [results];
  const verify = all.filter((r) => r?.rows?.length);
  for (const r of verify) console.table(r.rows);
  if (verify.length === 0) console.log("(no verify output)");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`FAILED — rolled back, nothing applied:\n  ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

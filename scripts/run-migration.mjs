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
 */
import fs from "node:fs";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/run-migration.mjs <path-to-sql>");
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
  await client.query("begin");
  const results = await client.query(sql);
  await client.query("commit");

  console.log(`applied ${file}`);
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

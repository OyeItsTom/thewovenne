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
 *   - takes the connection from SUPABASE_DB_URL (environment first, then the
 *     repository's .env.local), and prints host, port and database;
 *   - refuses unless --expect-host matches that host exactly, so a rollback
 *     meant for a rehearsal cannot reach Production, or the reverse;
 *   - refuses without --i-have-a-verified-backup (runbook R0 step 3);
 *   - on any error, issues ROLLBACK, prints the database's message and exits 1.
 *     The file's guards guarantee nothing changed in that case.
 *
 * It never prints the connection string or the password.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".sql"));
const at = args.indexOf("--expect-host");
const expectHost = at >= 0 ? args[at + 1] : null;
const backedUp = args.includes("--i-have-a-verified-backup");

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}
if (!file || !fs.existsSync(file)) fail("usage: node scripts/run-recovery-sql.mjs <file.sql> --expect-host <host> --i-have-a-verified-backup");
if (!expectHost) fail("Refusing: --expect-host <host> is required.");
if (!backedUp) fail("Refusing: take and verify a backup first, then pass --i-have-a-verified-backup.");

let url = process.env.SUPABASE_DB_URL;
if (!url) {
  const envFile = path.join(REPO, ".env.local");
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("SUPABASE_DB_URL="));
    if (line) url = line.slice("SUPABASE_DB_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
}
if (!url) fail("Refusing: SUPABASE_DB_URL is not set.");

const u = new URL(url);
const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
console.log(`target: host=${u.hostname} port=${u.port || "5432"} database=${u.pathname.slice(1)}`);
if (u.hostname !== expectHost) fail(`Refusing: host is ${u.hostname}, expected ${expectHost}. Nothing ran.`);

const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
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

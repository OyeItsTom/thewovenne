/**
 * scripts/stock-0060-preflight.sql — does it tell the truth about a database?
 *
 * Runs the owner's preflight, unmodified and inside `begin read only`, against
 * real throwaway databases (scripts/pg-world.ts) in each state it has to tell
 * apart: ready for 0060, already migrated, changed outside the migrations,
 * owned by someone else, and granted by someone else. A preflight that only
 * ever says PASS proves nothing, so each bad state must produce its verdict.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres> \
 *     npx tsx scripts/stock-preflight.test.ts
 *
 * Never touches a real database. Exits non-zero on failure.
 */
import fs from "node:fs";
import { handToOwner, startEngine, type Client } from "./pg-world";

const PREFLIGHT = fs.readFileSync("scripts/stock-0060-preflight.sql", "utf8");
const MIGRATION = fs.readFileSync("supabase/migrations/0060_publish_keeps_live_stock.sql", "utf8");

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

type Row = { id: string; verdict: string; observed: string | null };

async function preflight(c: Client, migrationRole = "postgres"): Promise<Record<string, Row>> {
  const sql = PREFLIGHT.replace("select 'postgres'::text as migration_role", `select '${migrationRole}'::text as migration_role`);
  await c.query("begin read only");
  try {
    const rows = (await c.query(sql)).rows as Row[];
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  } finally {
    await c.query("rollback");
  }
}
const verdicts = (r: Record<string, Row>, v: string) => Object.values(r).filter((x) => x.verdict === v).map((x) => x.id).sort();

/**
 * The ledger as scripts/run-migration.mjs would have left it. The harness
 * applies files directly, so 0057's backfill covers 0001–0056 and nothing
 * records 0057–0059.
 */
async function ledgerAsRunner(c: Client) {
  await c.query(`insert into schema_migrations (filename, applied_at) values
    ('0057_migration_ledger.sql', now()), ('0058_settlement_is_idempotent.sql', now()), ('0059_ai_daily_spend.sql', now())
    on conflict (filename) do nothing`);
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    return;
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);

  try {
    console.log("\n=== static: one read-only statement ===");
    {
      const code = PREFLIGHT.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").replace(/'(?:[^']|'')*'/g, "''").toLowerCase();
      check("no write, DDL, grant, transaction or side-effecting call outside comments and strings",
        code.match(/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|copy|call|do|perform|nextval|setval|set_config|pg_advisory\w*|begin|commit|rollback|vacuum|refresh)\b/g), null);
      check("exactly one statement", code.split(";").filter((x) => x.trim()).length, 1);
    }

    console.log("\n=== a database ready for 0060 ===");
    await engine.database("ready", "0059");
    const ready = await engine.connect("ready");
    await ledgerAsRunner(ready);
    const r1 = await preflight(ready);
    check("no BLOCKER", verdicts(r1, "BLOCKER"), []);
    check("no REVIEW", verdicts(r1, "REVIEW"), []);
    check("it ran every check", Object.keys(r1).length >= 25, true);
    check("the stale-stock draft count is 0 on a fresh database", r1.X01.observed, "0");

    console.log("\n=== ready, owned by a non-superuser role — production's shape ===");
    {
      await engine.database("readyns", "0059");
      const ns = await engine.connect("readyns");
      await ledgerAsRunner(ns);
      await handToOwner(ns, "readyns", "migrator2");
      const r = await preflight(ns, "migrator2");
      check("no BLOCKER", verdicts(r, "BLOCKER"), []);
      check("no REVIEW", verdicts(r, "REVIEW"), []);
      check("P02 reports it as not a superuser", /not superuser/.test(r.P02.observed ?? ""), true);
      await ns.end();
    }

    console.log("\n=== the same database after 0060 ===");
    await ready.query(MIGRATION);
    await ready.query("insert into schema_migrations (filename, applied_at) values ('0060_publish_keeps_live_stock.sql', now())");
    const r2 = await preflight(ready);
    check("already applied: L02, L03 and N01 are BLOCKERs", ["L02", "L03", "N01"].map((k) => r2[k].verdict), ["BLOCKER", "BLOCKER", "BLOCKER"]);
    check("…and the old save_product_sizes signature is reported missing (F01)", r2.F01.verdict, "BLOCKER");
    await ready.end();

    console.log("\n=== partly applied by hand, no ledger row ===");
    await engine.database("partial", "0059");
    const partial = await engine.connect("partial");
    await ledgerAsRunner(partial);
    await partial.query("alter table stock_movements add column request_id uuid");
    const r3 = await preflight(partial);
    check("N01 BLOCKER, naming the column", [r3.N01.verdict, /request_id/.test(r3.N01.observed ?? "")], ["BLOCKER", true]);
    await partial.end();

    console.log("\n=== changed outside the migrations ===");
    await engine.database("drift", "0059");
    const drift = await engine.connect("drift");
    await ledgerAsRunner(drift);
    await drift.query(`create or replace function public.log_admin_action() returns trigger language plpgsql security definer
      set search_path = public as $x$ begin return coalesce(new, old); end $x$`);
    await drift.query("create trigger someone_elses before update on product_sizes for each row execute function public.log_admin_action()");
    const r4 = await preflight(drift);
    check("a hand-edited function body is REVIEW (F03), naming it", [r4.F03.verdict, /log_admin_action/.test(r4.F03.observed ?? "")], ["REVIEW", true]);
    check("an unknown trigger on a stock table is REVIEW (R02)", [r4.R02.verdict, r4.R02.observed], ["REVIEW", "product_sizes.someone_elses"]);
    await drift.query("alter table product_sizes force row level security");
    check("FORCED row-level security is a BLOCKER (T05)", (await preflight(drift)).T05.verdict, "BLOCKER");
    await drift.query(`do $$ begin create role someone_else nologin; exception when duplicate_object then null; end $$;
      alter function public.is_admin() owner to someone_else`);
    check("a function owned by another role is a BLOCKER (F02)", (await preflight(drift)).F02.verdict, "BLOCKER");
    await drift.query(`grant execute on function public.reserve_stock(jsonb, uuid) to authenticated`);
    check("reserve_stock reachable by signed-in users is REVIEW (G01)", (await preflight(drift)).G01.verdict, "REVIEW");
    await drift.end();

    console.log("\n=== a non-superuser migration role, with a grant it cannot revoke ===");
    await engine.database("grantdb", "0059");
    const foreign = await engine.connect("grantdb");
    await ledgerAsRunner(foreign);
    await foreign.query(`do $$ begin create role migrator nologin nosuperuser; exception when duplicate_object then null; end $$;
      do $$ begin create role other_grantor nologin; exception when duplicate_object then null; end $$;
      alter database grantdb owner to migrator`);
    const asMigrator = await preflight(foreign, "migrator");
    check("functions and tables not owned by the migration role are BLOCKERs (F02, T01)",
      [asMigrator.F02.verdict, asMigrator.T01.verdict], ["BLOCKER", "BLOCKER"]);
    check("…but it does act for pg_database_owner, so S01 passes", asMigrator.S01.verdict, "PASS");
    await foreign.query(`grant create on schema public to other_grantor with grant option;
      set role other_grantor; grant create on schema public to anon; reset role`);
    const r5 = await preflight(foreign, "migrator");
    check("CREATE reaching anon through another role's grant is a BLOCKER (S02)", r5.S02.verdict, "BLOCKER");
    check("…and the grant is named", /anon \(granted by other_grantor\)/.test(r5.S02.observed ?? ""), true);
    await foreign.query("grant create on schema public to public");
    check("PUBLIC holding CREATE is at least REVIEW (S02)", ["REVIEW", "BLOCKER"].includes((await preflight(foreign, "migrator")).S02.verdict), true);
    await foreign.end();

    console.log("\n=== missing prerequisites ===");
    await engine.database("old", "0057");
    const old = await engine.connect("old");
    const r6 = await preflight(old);
    check("without 0058 the sale-claim index is missing: BLOCKER (T04)", r6.T04.verdict, "BLOCKER");
    check("…and the latest ledger entry is not 0059: REVIEW (L03)", r6.L03.verdict, "REVIEW");
    await old.end();
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

/**
 * Wovenne's database security posture, as data — and the check that a database
 * matches it.
 *
 *   # a clean replay (shim → privilege baseline → every migration) vs the manifest
 *   PG_HARNESS_DIR=/tmp/pgh npx tsx scripts/security-posture.ts --replay
 *   # …and rewrite the manifest from that replay (after a reviewed migration)
 *   PG_HARNESS_DIR=/tmp/pgh npx tsx scripts/security-posture.ts --replay --write
 *   # PRODUCTION vs the manifest — read-only: a READ ONLY transaction, catalog
 *   # queries only, always rolled back. Reads SUPABASE_DB_URL from .env.local.
 *   npx tsx scripts/security-posture.ts --production
 *
 * The manifest (supabase/security-posture.json) records, for every Wovenne-owned
 * object in public (and the storage policies and buckets the migrations make):
 * RLS on/off, every policy, what anon / authenticated / service_role can
 * actually do (effective privileges — PUBLIC grants included), column-level
 * grants, and each function's EXECUTE, SECURITY DEFINER and search_path. It is
 * generated from a clean replay, never edited by hand, and committed — so a
 * migration that changes who can do what changes this file in the same diff.
 *
 * Supabase's platform internals (auth, realtime, vault, event triggers,
 * extensions, owners, OIDs) are deliberately not in it.
 *
 * Privileges the Data API cannot exercise (TRUNCATE, REFERENCES, TRIGGER) are
 * reported separately as `nonApiTablePrivileges` and are not compared: the
 * baseline grants none, production's project defaults grant some (see
 * supabase/README.md, "Privilege baseline").
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export const MANIFEST = path.join(process.cwd(), "supabase", "security-posture.json");

const ROLES = ["anon", "authenticated", "service_role"] as const;
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const NON_API = ["TRUNCATE", "REFERENCES", "TRIGGER"];

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export interface Posture {
  publicSchemaCreate: Record<string, boolean>;
  tables: Record<string, {
    kind: string;
    rls: boolean;
    forceRls: boolean;
    privileges: Record<string, string[]>;
    /** Column grants beyond the table-level ones: role → privilege → columns. */
    columns: Record<string, Record<string, string[]>>;
  }>;
  sequences: Record<string, Record<string, string[]>>;
  functions: Record<string, { securityDefiner: boolean; searchPath: string | null; execute: string[] }>;
  policies: Record<string, { cmd: string; permissive: string; roles: string[]; using: string | null; check: string | null }>;
  buckets: Record<string, { public: boolean }>;
}

export interface PostureWithExtras {
  posture: Posture;
  nonApiTablePrivileges: Record<string, string[]>;
}

export async function readPosture(c: Q): Promise<PostureWithExtras> {
  const posture: Posture = { publicSchemaCreate: {}, tables: {}, sequences: {}, functions: {}, policies: {}, buckets: {} };
  const nonApi: Record<string, string[]> = {};

  for (const r of ROLES) {
    posture.publicSchemaCreate[r] = (await c.query("select has_schema_privilege($1, 'public', 'CREATE') v", [r])).rows[0].v;
  }

  const rels = (await c.query(`
    select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f')
     order by c.relname`)).rows;
  for (const rel of rels) {
    const privileges: Record<string, string[]> = {};
    const columns: Record<string, Record<string, string[]>> = {};
    for (const r of ROLES) {
      privileges[r] = (await c.query(
        "select array_agg(p order by p) v from unnest($3::text[]) p where has_table_privilege($1, $2::oid, p)",
        [r, rel.oid, DML])).rows[0].v ?? [];
      const extra = (await c.query(
        "select array_agg(p order by p) v from unnest($3::text[]) p where has_table_privilege($1, $2::oid, p)",
        [r, rel.oid, NON_API])).rows[0].v ?? [];
      if (r !== "service_role" && extra.length) nonApi[`${rel.relname}:${r}`] = extra;
      for (const p of ["SELECT", "INSERT", "UPDATE"]) {
        if (privileges[r].includes(p)) continue;
        const cols = (await c.query(
          `select array_agg(a.attname::text order by a.attname) v from pg_attribute a
            where a.attrelid = $2::oid and a.attnum > 0 and not a.attisdropped and has_column_privilege($1, $2::oid, a.attnum, $3)`,
          [r, rel.oid, p])).rows[0].v;
        if (cols) (columns[r] ??= {})[p] = cols;
      }
    }
    posture.tables[rel.relname] = { kind: rel.relkind, rls: rel.relrowsecurity, forceRls: rel.relforcerowsecurity, privileges, columns };
  }

  const seqs = (await c.query("select c.oid, c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' order by 2")).rows;
  for (const s of seqs) {
    const out: Record<string, string[]> = {};
    for (const r of ROLES) {
      out[r] = (await c.query(
        "select array_agg(p order by p) v from unnest(array['SELECT','UPDATE','USAGE']) p where has_sequence_privilege($1, $2::oid, p)",
        [r, s.oid])).rows[0].v ?? [];
    }
    posture.sequences[s.relname] = out;
  }

  const fns = (await c.query(`
    select p.oid, p.oid::regprocedure::text sig, p.prosecdef,
           (select substr(x, 13) from unnest(coalesce(p.proconfig, '{}')) x where x like 'search_path=%') search_path
      from pg_proc p where p.pronamespace = 'public'::regnamespace order by 2`)).rows;
  for (const f of fns) {
    const execute: string[] = [];
    for (const r of ROLES) {
      if ((await c.query("select has_function_privilege($1, $2::oid, 'EXECUTE') v", [r, f.oid])).rows[0].v) execute.push(r);
    }
    posture.functions[f.sig] = { securityDefiner: f.prosecdef, searchPath: f.search_path, execute };
  }

  const pols = (await c.query(`
    select schemaname || '.' || tablename || '.' || policyname k, cmd, permissive, roles::text[] roles, qual, with_check
      from pg_policies where schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects') order by 1`)).rows;
  for (const p of pols) {
    posture.policies[p.k] = { cmd: p.cmd, permissive: p.permissive, roles: [...p.roles].sort(), using: p.qual, check: p.with_check };
  }

  for (const b of (await c.query("select id, public from storage.buckets order by id")).rows) {
    posture.buckets[b.id] = { public: b.public };
  }

  return { posture, nonApiTablePrivileges: nonApi };
}

/** Every difference between two postures, as readable lines. Empty means equal. */
export function comparePostures(expected: unknown, actual: unknown, at = ""): string[] {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  const isObj = (x: unknown) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObj(expected) || !isObj(actual)) {
    return [`${at || "(root)"}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`];
  }
  const e = expected as Record<string, unknown>, a = actual as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
    const p = at ? `${at}.${k}` : k;
    if (!(k in a)) out.push(`${p}: missing (expected ${JSON.stringify(e[k])})`);
    else if (!(k in e)) out.push(`${p}: unexpected ${JSON.stringify(a[k])}`);
    else out.push(...comparePostures(e[k], a[k], p));
  }
  return out;
}

export function readManifest(): Posture {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Posture;
}

async function main() {
  const args = process.argv.slice(2);
  let found: PostureWithExtras;
  let where: string;

  if (args.includes("--production")) {
    const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
    if (!env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is not set in .env.local");
    const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false },
      options: "-c default_transaction_read_only=on -c statement_timeout=60000" });
    await c.connect();
    try {
      await c.query("begin transaction isolation level repeatable read read only");
      if ((await c.query("select current_setting('transaction_read_only') v")).rows[0].v !== "on") {
        throw new Error("the transaction is not read-only — refusing to continue");
      }
      found = await readPosture(c);
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
    where = "production";
  } else if (args.includes("--replay")) {
    const { startEngine } = await import("./pg-world");
    const engine = await startEngine();
    if (!engine) throw new Error("embedded-postgres not found — set PG_HARNESS_DIR");
    try {
      await engine.database("posture");
      const c = await engine.connect("posture");
      found = await readPosture(c);
      await c.end();
    } finally {
      await engine.stop();
    }
    where = "clean replay";
  } else {
    console.error("usage: security-posture.ts --replay [--write] | --production");
    process.exit(2);
  }

  if (args.includes("--write")) {
    if (where !== "clean replay") throw new Error("--write only from --replay: the manifest is what the migrations produce");
    fs.writeFileSync(MANIFEST, JSON.stringify(found.posture, null, 2) + "\n");
    console.log(`wrote ${path.relative(process.cwd(), MANIFEST)}`);
  }

  const diffs = comparePostures(readManifest(), found.posture);
  const extras = Object.entries(found.nonApiTablePrivileges);
  console.log(`\n${where}: ${Object.keys(found.posture.tables).length} tables/views, ${Object.keys(found.posture.functions).length} functions, ` +
    `${Object.keys(found.posture.policies).length} policies, ${Object.keys(found.posture.sequences).length} sequences`);
  console.log(`non-API table privileges held by anon/authenticated (not compared): ${extras.length} grants` +
    (extras.length ? ` across ${new Set(extras.map(([k]) => k.split(":")[0])).size} tables (${[...new Set(extras.flatMap(([, v]) => v))].join(", ")})` : ""));
  if (diffs.length) {
    console.log(`\nDIFFERS from supabase/security-posture.json — ${diffs.length}:`);
    for (const d of diffs) console.log(`  ${d}`);
    process.exit(1);
  }
  console.log("\nMATCHES supabase/security-posture.json");
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith("security-posture")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

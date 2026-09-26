/**
 * A real, throwaway PostgreSQL for migration tests — never the production one.
 *
 * Starts a private cluster with `embedded-postgres` (real Postgres binaries, run
 * as a local process on a random port, deleted afterwards), lays a thin stand-in
 * for the parts of Supabase the migrations reference (roles, auth.uid(),
 * storage), and applies supabase/migrations in order, UNMODIFIED. Tests then run
 * the real functions, through the real grants, as the real roles.
 *
 * Unlike PGlite this is a server: several connections, real row locks, real
 * lock waits and real deadlock detection — which is what a concurrency test
 * needs and what PGlite cannot give.
 *
 * embedded-postgres is not a project dependency (it downloads ~30MB of
 * binaries). Point PG_HARNESS_DIR at a directory where it is installed:
 *
 *   mkdir -p /tmp/pgh && npm install --prefix /tmp/pgh embedded-postgres
 *   PG_HARNESS_DIR=/tmp/pgh npx tsx scripts/stock-integrity.test.ts
 *
 * Nothing here reads .env.local or any credential.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

export type Client = pg.Client;

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");

/**
 * Just enough Supabase for the migrations to apply and the functions to run.
 * auth.uid() reads the same setting PostgREST sets, so `asAdmin` below is how a
 * signed-in admin's request looks from inside the database.
 */
export const SUPABASE_SHIM = `
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as
  $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
create or replace function auth.role() returns text language sql stable as
  $f$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $f$;
create or replace function auth.email() returns text language sql stable as
  $f$ select nullif(current_setting('request.jwt.claim.email', true), '') $f$;
create or replace function auth.jwt() returns jsonb language sql stable as
  $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text,
  name text, owner uuid, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as
  $f$ select string_to_array(name, '/') $f$;
grant usage on schema auth, storage to anon, authenticated, service_role;
-- Supabase's own grants, so permission tests mean something: every table,
-- function and sequence created in public is granted to the API roles unless a
-- migration revokes it, and — the worst case, not confirmed for this project —
-- the API roles may CREATE in public. Migrations must hold up against that.
grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

interface EmbeddedPostgresCtor {
  new (opts: Record<string, unknown>): {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}

async function loadEmbedded(): Promise<EmbeddedPostgresCtor | null> {
  // Located by path rather than require.resolve: the package's `exports` map
  // exposes only its ESM entry, so neither its package.json nor a CommonJS
  // resolve of it is allowed.
  const candidates = [process.env.PG_HARNESS_DIR, process.cwd()].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      const entry = path.join(dir, "node_modules", "embedded-postgres", "dist", "index.js");
      if (!fs.existsSync(entry)) continue;
      const mod = (await import(pathToFileURL(entry).href)) as { default: EmbeddedPostgresCtor };
      return mod.default;
    } catch {
      /* try the next */
    }
  }
  return null;
}

export interface Engine {
  version: string;
  /** A new database with the shim and migrations applied, up to and including `through`. */
  database(name: string, through?: string): Promise<void>;
  connect(name: string): Promise<Client>;
  stop(): Promise<void>;
}

const PASSWORD = "throwaway";

export async function startEngine(): Promise<Engine | null> {
  const EmbeddedPostgres = await loadEmbedded();
  if (!EmbeddedPostgres) return null;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wovenne-pg-"));
  const port = 55000 + Math.floor(Math.random() * 5000);
  const server = new EmbeddedPostgres({
    databaseDir: path.join(dataDir, "data"),
    user: "postgres",
    password: PASSWORD,
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();

  const connect = async (database: string) => {
    const c = new pg.Client({ host: "localhost", port, user: "postgres", password: PASSWORD, database });
    c.on("notice", () => {});
    // Stopping the server ends every connection with 57P01; that is the
    // teardown, not a failure, and must not crash the process.
    c.on("error", () => {});
    await c.connect();
    return c;
  };

  const root = await connect("postgres");
  const version = (await root.query("select version() v")).rows[0].v as string;
  // Roles are cluster-wide: create them once, before any database needs them.
  await root.query(SUPABASE_SHIM.split("\n").filter((l) => l.startsWith("do $$")).join("\n"));

  return {
    version,
    async database(name, through) {
      await root.query(`create database ${name}`);
      const c = await connect(name);
      try {
        await c.query(SUPABASE_SHIM);
        const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
        for (const f of files) {
          try {
            await c.query(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
          } catch (e) {
            throw new Error(`${f} failed to apply: ${(e as Error).message}`);
          }
          if (through && f.startsWith(through)) break;
        }
      } finally {
        await c.end();
      }
    },
    connect,
    async stop() {
      await root.end();
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ── Acting as someone ─────────────────────────
// Session-level, so a connection keeps its identity across transactions.

export async function asRoot(c: Client) {
  await c.query("reset role");
  await c.query("select set_config('request.jwt.claim.sub', '', false)");
}

export async function asAdmin(c: Client, adminId: string) {
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, false)", [adminId]);
}

export async function asService(c: Client) {
  await c.query("set role service_role");
  await c.query("select set_config('request.jwt.claim.sub', '', false)");
}

/** An auth user promoted to admin, the way 0008 promotes one. */
export async function makeAdmin(root: Client, email = "admin@example.test"): Promise<string> {
  await asRoot(root);
  const { rows } = await root.query("insert into auth.users (email) values ($1) returning id", [email]);
  const id = rows[0].id as string;
  await root.query(
    "insert into profiles (id, email, is_admin) values ($1, $2, true) on conflict (id) do update set is_admin = true",
    [id, email]
  );
  return id;
}

/** The message of whatever `fn` throws, or "" if it does not throw. */
export async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

/** SQLSTATE of whatever `fn` throws, or "". */
export async function failureCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return String((e as { code?: string }).code ?? "");
  }
}

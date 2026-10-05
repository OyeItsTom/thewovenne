#!/usr/bin/env node
/**
 * Build, refill and reset the STAGING Supabase project. Never production.
 *
 *   node scripts/staging.mjs status                 what the staging DB holds
 *   node scripts/staging.mjs bootstrap              apply every pending migration, in order
 *   node scripts/staging.mjs seed                   replace the catalogue with the baseline
 *   node scripts/staging.mjs reset --yes            clear test activity, remove customer
 *                                                   accounts and uploads, migrate, re-seed
 *   node scripts/staging.mjs user --email a@b.test  a confirmed customer login (no email sent)
 *   node scripts/staging.mjs delete-user --email a@b.test
 *
 * Reads .env.staging by default (or --env-file=<path> / $WOVENNE_ENV_FILE). It
 * must declare WOVENNE_ENV=staging and must not name the production project —
 * there is no --production for this script, by design. See docs/staging.md for
 * the order of first-time setup: bootstrap → add-admin → seed.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { loadScriptEnv } from "./lib/scriptEnv.mjs";
import {
  STAGING_CATALOGUE,
  TABLE_POLICY,
  applyPendingMigrations,
  clearDisposable,
  imagePaths,
  migrationFiles,
  seedCatalogue,
  unclassifiedTables,
} from "./lib/staging.mjs";

const args = process.argv.slice(2);
const command = args.find((a, i) => !a.startsWith("--") && !["--env-file", "--env", "--email"].includes(args[i - 1]));
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const COMMANDS = ["status", "bootstrap", "seed", "reset", "user", "delete-user"];
if (!COMMANDS.includes(command)) {
  console.error(`usage: node scripts/staging.mjs <${COMMANDS.join("|")}> [--env-file=.env.staging]`);
  process.exit(1);
}

// The guard runs before any client exists. Staging-only: production is refused
// even with --production, and the file must say WOVENNE_ENV=staging.
const env = loadScriptEnv({ argv: args, stagingOnly: true, defaultFile: ".env.staging" });

for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL"]) {
  if (!env[k]) {
    console.error(`${k} is missing from the staging env file.`);
    process.exit(1);
  }
}

const BUCKETS = ["product-images", "style-photos"];
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

const publicUrl = (path) => supabase.storage.from("product-images").getPublicUrl(path).data.publicUrl;

/** A plain card that says STAGING, so a staging photograph can never be mistaken for a product. */
async function placeholderJpeg(title, n) {
  const hue = [28, 200, 140, 350, 260][n % 5];
  const safe = title.replace(/[<>&"']/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
    <rect width="100%" height="100%" fill="hsl(${hue},35%,82%)"/>
    <text x="50%" y="46%" font-family="Helvetica, Arial, sans-serif" font-size="72" text-anchor="middle" fill="#1c1f3b">STAGING</text>
    <text x="50%" y="54%" font-family="Helvetica, Arial, sans-serif" font-size="34" text-anchor="middle" fill="#1c1f3b">${safe}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

async function uploadCatalogueImages() {
  let n = 0;
  for (const e of STAGING_CATALOGUE) {
    for (const path of imagePaths(e)) {
      const body = await placeholderJpeg(`${e.name} ${path.at(-5)}`, n++);
      const { error } = await supabase.storage
        .from("product-images")
        .upload(path, body, { contentType: "image/jpeg", upsert: true, cacheControl: "3600" });
      if (error) throw new Error(`upload ${path}: ${error.message}`);
    }
  }
  return n;
}

async function listAll(bucket, prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      // Folders come back with no id.
      if (item.id === null) out.push(...(await listAll(bucket, full)));
      else out.push(full);
    }
    if (data.length < 1000) break;
  }
  return out;
}

async function emptyBuckets() {
  let removed = 0;
  for (const bucket of BUCKETS) {
    const paths = await listAll(bucket);
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await supabase.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (error) throw new Error(`remove from ${bucket}: ${error.message}`);
    }
    removed += paths.length;
  }
  return removed;
}

async function allUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return users;
}

/** Every login that is not staff. Their profiles, carts, wishlists and the rest cascade. */
async function deleteCustomerAccounts() {
  const staff = new Set((await db.query("select id from profiles where is_admin")).rows.map((r) => r.id));
  let deleted = 0;
  for (const u of await allUsers()) {
    if (staff.has(u.id)) continue;
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) throw new Error(`deleteUser ${u.email}: ${error.message}`);
    deleted++;
  }
  return { deleted, kept: staff.size };
}

async function seed() {
  const admin = (await db.query("select id, email from profiles where is_admin order by created_at limit 1")).rows[0];
  if (!admin) {
    throw new Error(
      "no staff account on staging. Create one first:\n  node scripts/add-admin.mjs --env-file=.env.staging --email <you>"
    );
  }
  const images = await uploadCatalogueImages();
  const made = await seedCatalogue(db, { adminId: admin.id, imageUrl: publicUrl });
  console.log(`seeded ${Object.keys(made).length} products (${images} images) as ${admin.email}`);
}

async function status() {
  const ledger = (await db.query("select to_regclass('public.schema_migrations') is not null ok")).rows[0].ok
    ? (await db.query("select filename from schema_migrations order by 1")).rows.map((r) => r.filename)
    : [];
  const files = migrationFiles();
  console.log(`migrations: ${ledger.length} recorded of ${files.length} in the repo; latest ${ledger.at(-1) ?? "none"}`);
  const pending = files.filter((f) => !ledger.includes(f));
  if (pending.length) console.log(`  pending: ${pending.join(", ")}`);
  if (!ledger.length) return;
  const unknown = await unclassifiedTables(db);
  if (unknown.length) console.log(`  UNCLASSIFIED tables (reset will refuse): ${unknown.join(", ")}`);
  for (const t of [...TABLE_POLICY.disposable, "profiles"]) {
    const { n } = (await db.query(`select count(*)::int n from public.${t}`)).rows[0];
    if (n) console.log(`  ${t.padEnd(26)} ${n}`);
  }
  const staff = (await db.query("select email from profiles where is_admin")).rows.map((r) => r.email);
  console.log(`staff: ${staff.join(", ") || "none — run add-admin"}`);
  console.log(`auth users: ${(await allUsers()).length}`);
}

try {
  await db.connect();

  if (command === "status") {
    await status();
  } else if (command === "bootstrap") {
    const r = await applyPendingMigrations(db, { log: (m) => console.log(`  ${m}`) });
    console.log(`migrations: applied ${r.applied.length}; ${r.total} in the repo, all recorded.`);
    const unknown = await unclassifiedTables(db);
    if (unknown.length) console.log(`WARNING: unclassified tables ${unknown.join(", ")} — reset will refuse until TABLE_POLICY lists them.`);
    console.log("next: node scripts/add-admin.mjs --env-file=.env.staging --email <you>, then node scripts/staging.mjs seed");
  } else if (command === "seed") {
    await seed();
  } else if (command === "reset") {
    if (!args.includes("--yes")) {
      console.error("reset deletes every customer login, order, cart, upload and product on STAGING. Pass --yes.");
      process.exit(1);
    }
    const m = await applyPendingMigrations(db);
    console.log(`migrations: applied ${m.applied.length} pending`);
    await clearDisposable(db);
    console.log(`cleared ${TABLE_POLICY.disposable.length} disposable tables`);
    const u = await deleteCustomerAccounts();
    console.log(`auth: deleted ${u.deleted} customer login(s), kept ${u.kept} staff`);
    console.log(`storage: removed ${await emptyBuckets()} object(s)`);
    await seed();
  } else if (command === "user") {
    const email = flag("--email");
    if (!email) throw new Error("pass --email");
    const password = Array.from(randomBytes(20), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"[b % 57]).join("");
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser: ${error.message}`);
    console.log(`customer ${email} (${data.user.id}) created on staging, confirmed, no email sent.`);
    console.log(`password: ${password}`);
  } else if (command === "delete-user") {
    const email = flag("--email");
    const u = (await allUsers()).find((x) => x.email === email);
    if (!u) throw new Error(`no staging user ${email}`);
    const isStaff = (await db.query("select is_admin from profiles where id = $1", [u.id])).rows[0]?.is_admin;
    if (isStaff) throw new Error(`${email} is staff; use add-admin.mjs --revoke first`);
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) throw new Error(error.message);
    console.log(`deleted ${email}`);
  }
} catch (e) {
  console.error(`\nFAILED: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}

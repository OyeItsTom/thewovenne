/**
 * A database rebuilt from the migrations has production's security posture —
 * and a migration that leans on Supabase's broad default grants is noticed.
 *
 *   PG_HARNESS_DIR=/tmp/pgh npx --cache /tmp/npmcache --yes tsx@4.19.2 scripts/privilege-baseline.test.ts
 *
 * Every database here is built the way a new project is: a STANDARD Supabase
 * project's default grants (broad, to every API role), then
 * supabase/bootstrap/privilege_baseline.sql, then every migration unmodified.
 * The 5 October 2026 audit found that without the baseline the same migrations
 * give anon and authenticated far more than production has, and that
 * site_pages had RLS on in production only (fixed by 0064).
 *
 * supabase/security-posture.json is the intended posture, generated from a
 * clean replay; `scripts/security-posture.ts --production` checks production
 * against the same file, read-only. Without embedded-postgres the database
 * half is skipped and the run exits non-zero rather than passing.
 *
 * Section 9 models Supabase's 30 October 2026 Data API change (changelog
 * 45329): new tables and sequences in public stop receiving automatic grants,
 * for service_role too. The plain replay cannot show it — 0004 and the
 * baseline give service_role default privileges on every rebuild — so 9
 * applies Supabase's own statements after the last legacy migration, and
 * requires every later migration to produce the same posture with or without
 * them.
 */
import fs from "node:fs";
import path from "node:path";
import { asAdmin, asRoot, asService, asUser, failure, failureCode, makeAdmin, startEngine, type Client } from "./pg-world";
import { comparePostures, readManifest, readPosture } from "./security-posture";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

const BASELINE = fs.readFileSync(path.join("supabase", "bootstrap", "privilege_baseline.sql"), "utf8");
const M0064 = fs.readFileSync(path.join("supabase", "migrations", "0064_site_pages_row_level_security.sql"), "utf8");

console.log("\nthe files");
t("the baseline is not in supabase/migrations (no runner may pick it up as a migration)",
  !fs.readdirSync(path.join("supabase", "migrations")).some((f) => /baseline/i.test(f)));
t("the baseline sets default privileges only for postgres, only in public",
  [...BASELINE.matchAll(/alter default privileges[^;]*;/gi)].every((m) => /for role postgres in schema public/i.test(m[0])) &&
  [...BASELINE.matchAll(/alter default privileges/gi)].length === 6);
t("the baseline never names a Supabase-managed schema in a statement",
  !/^\s*(alter|grant|revoke|create|drop)[^;]*\b(auth|storage|realtime|graphql|vault|extensions)\./im.test(BASELINE));
t("0064 creates no policy", !/create\s+policy/i.test(M0064));
t("0064 touches only site_pages", [...M0064.matchAll(/^\s*(alter table|revoke|grant)\s[^;]*;/gim)].every((m) => /public\.site_pages\b/.test(m[0])));
t("the harness applies the baseline file itself", /privilege_baseline\.sql/.test(fs.readFileSync("scripts/pg-world.ts", "utf8")));

// ── Supabase's Data API change (30 Oct 2026) ──
// The statements Supabase publishes (changelog 45329) and applies to existing
// projects: new tables and sequences in public get no automatic Data API grants.
const SUPABASE_30_OCT = `
  alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated, service_role;
  alter default privileges for role postgres in schema public revoke usage, select on sequences from anon, authenticated, service_role;`;

// Every migration after this one must not depend on default privileges, whenever
// it is applied: its objects must come out the same with or without the change.
const LAST_LEGACY_MIGRATION = "0073";

// Objects created after 0004 whose service_role access comes ONLY from default
// privileges (0004's `alter default privileges`, re-created by the baseline).
// Production holds these grants and keeps them; a rebuild gets them from 0004.
// Nothing may be added to this list — a new object grants explicitly instead.
const LEGACY_IMPLICIT_SERVICE_ROLE = [
  "sequences.analytics_events_id_seq.service_role",
  "sequences.credit_note_number_seq.service_role",
  "sequences.invoice_number_seq.service_role",
  "tables.coupon_redemptions.privileges.service_role",
  "tables.coupons.privileges.service_role",
  "tables.credit_notes.privileges.service_role",
  "tables.expenses.privileges.service_role",
  "tables.public_style_submissions.privileges.service_role",
  "tables.razorpay_webhook_events.privileges.service_role",
  "tables.schema_migrations.privileges.service_role",
  "tables.stock_movements.privileges.service_role",
  "tables.stock_requests.privileges.service_role",
  "tables.style_submissions.privileges.service_role",
];

const MIGRATIONS_DIR = path.join("supabase", "migrations");
const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

/**
 * The rule for migrations after LAST_LEGACY_MIGRATION, read from the SQL text:
 * every table, view or sequence created in public has, in the same file, an
 * explicit grant or revoke naming each of anon, authenticated and service_role
 * (`revoke all … from anon, authenticated, service_role`, then only the grants
 * a real caller needs, is the simplest), and every table enables RLS. Objects
 * in other schemas, indexes and functions are not its concern.
 *
 * Text cannot tell whether those statements leave anything to default
 * privileges (a lone `grant select … to service_role`, a sequence made by an
 * identity or serial column) — the database half of 9 catches that.
 */
function grantDecisionProblems(sql: string): string[] {
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
  const problems: string[] = [];
  // object → roles named by some grant or revoke on it (object lists allowed, as in 0068)
  const addressed = new Map<string, Set<string>>();
  const statements = text.matchAll(/\b(?:grant|revoke)\s+[^;]*?\s+on\s+(?:table\s+|sequence\s+)?([^;]*?)\s+(?:to|from)\s+([^;]+);/gi);
  for (const s of statements) {
    const roles = s[2].split(",").map((r) => r.trim().split(/\s+/)[0].toLowerCase());
    for (const object of s[1].split(",")) {
      const name = object.trim().toLowerCase().replace(/^public\./, "");
      const set = addressed.get(name) ?? new Set<string>();
      roles.forEach((r) => set.add(r));
      addressed.set(name, set);
    }
  }
  const created = text.matchAll(
    /\bcreate\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(table|sequence|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)/gi);
  for (const m of created) {
    if (m[2] && m[2].toLowerCase() !== "public") continue;
    const kind = m[1].toLowerCase().replace(/\s+/, " ");
    const name = m[3].toLowerCase();
    const missing = ["anon", "authenticated", "service_role"].filter((r) => !addressed.get(name)?.has(r));
    if (missing.length) problems.push(`${kind} ${name}: no explicit grant or revoke for ${missing.join(", ")}`);
    if (kind === "table" && !new RegExp(
      `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?${name}\\s+enable\\s+row\\s+level\\s+security`, "i").test(text)) {
      problems.push(`table ${name}: RLS not enabled`);
    }
  }
  return problems;
}

/** The posture paths on which two databases differ ("tables.x.privileges.role", …). */
function differingPaths(a: unknown, b: unknown): string[] {
  return comparePostures(a, b).map((d) => d.slice(0, d.indexOf(":")));
}

async function rowsOrCode(c: Client, sql: string): Promise<string> {
  try {
    const r = await c.query(sql);
    return `rows=${r.rowCount}`;
  } catch (e) {
    return String((e as { code?: string }).code ?? "error");
  }
}

console.log("\nthe grant-decision text rule (used in 9) — what it accepts and rejects");
const accepts: [string, string][] = [
  ["an index-only migration", "create index if not exists zz_idx on public.products (slug);"],
  ["a function-only migration (returns table)", `create or replace function public.zz_f() returns table (id int) language sql as $$ select 1 $$;
    revoke execute on function public.zz_f() from public;`],
  ["a sequence-only migration", `create sequence public.zz_s; revoke all on sequence public.zz_s from anon, authenticated, service_role;
    grant usage on sequence public.zz_s to service_role;`],
  ["a view (no RLS asked of it)", `create or replace view public.zz_v with (security_invoker = true) as select 1 x;
    revoke all on public.zz_v from anon, authenticated, service_role; grant select on public.zz_v to anon;`],
  ["one statement covering several tables, and an explicit service_role grant instead of a revoke (0068's style)",
    `create table public.zz_a (id int); create table public.zz_b (id int);
    alter table public.zz_a enable row level security; alter table public.zz_b enable row level security;
    revoke all on public.zz_a, public.zz_b from public, anon, authenticated;
    grant select, insert, update, delete on public.zz_a, public.zz_b to service_role;`],
  ["a table in another schema, and one only inside a block comment", "create table private.zz_p (id int); /* create table public.zz_ghost (id int); */"],
];
for (const [what, sql] of accepts) t(`accepts ${what}`, grantDecisionProblems(sql).length === 0, grantDecisionProblems(sql).join("; "));
const explicitEra = MIGRATION_FILES.filter((x) => x >= "0058");
const eraProblems = explicitEra.flatMap((x) => grantDecisionProblems(fs.readFileSync(path.join(MIGRATIONS_DIR, x), "utf8")).map((p) => `${x}: ${p}`));
t(`accepts every real migration since explicit grants became the rule (0058–, ${explicitEra.length} files)`, eraProblems.length === 0, eraProblems.join("; "));
const rejects: [string, string, string][] = [
  ["a table without RLS", "create table public.zz_t (id int); revoke all on public.zz_t from anon, authenticated, service_role;", "table zz_t: RLS not enabled"],
  ["a view with no decision", "create view public.zz_v as select 1 x;", "view zz_v: no explicit grant or revoke for anon, authenticated, service_role"],
  ["a table that forgets service_role", `create table public.zz_t (id int); alter table public.zz_t enable row level security;
    revoke all on public.zz_t from anon, authenticated;`, "table zz_t: no explicit grant or revoke for service_role"],
];
for (const [what, sql, expected] of rejects) {
  t(`rejects ${what}`, grantDecisionProblems(sql).includes(expected), grantDecisionProblems(sql).join("; "));
}

(async () => {
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database half — embedded-postgres not found (set PG_HARNESS_DIR)");
    console.log(`\n${pass} passed, ${fail} failed (database half skipped)`);
    process.exit(1);
  }
  console.log(`\n(${engine.version.split(" on ")[0]})`);
  try {
    await engine.database("w");
    const c = await engine.connect("w");
    await asRoot(c);
    const admin = await makeAdmin(c);
    const customer = (await c.query("insert into auth.users (email) values ('customer@example.test') returning id")).rows[0].id as string;
    await c.query("insert into profiles (id, email) values ($1, 'customer@example.test') on conflict (id) do nothing", [customer]);
    const seededPages = (await c.query("select count(*)::int n from site_pages")).rows[0].n as number;

    // ── 1–3. site_pages ───────────────────────────
    console.log("\n1. site_pages after a clean replay");
    const rel = (await c.query("select relrowsecurity rls, (select count(*)::int from pg_policy where polrelid = 'site_pages'::regclass) pols from pg_class where oid = 'site_pages'::regclass")).rows[0];
    t("RLS is enabled", rel.rls === true);
    t("with no policy (every API-role row access denied)", rel.pols === 0);
    t("the seeded pages exist (so 'no rows' below means hidden, not empty)", seededPages > 0, `${seededPages}`);

    const page = (await c.query("select id from site_pages limit 1")).rows[0].id as string;
    const attempts = (role: string) => [
      ["insert", "insert into site_pages default values"],
      ["update", `update site_pages set created_at = now() where id = '${page}'`],
      ["delete", `delete from site_pages where id = '${page}'`],
      ["truncate", "truncate site_pages cascade"],
    ].map(([what, sql]) => ({ what: `${role} ${what}`, sql }));

    console.log("\n2. anon cannot modify site_pages");
    for (const a of attempts("anon")) {
      await c.query("set role anon");
      const got = await rowsOrCode(c, a.sql);
      await asRoot(c);
      t(`${a.what} → permission denied`, got === "42501", got);
    }
    await c.query("set role anon");
    t("anon select → no rows (the grant stays, RLS hides every row)", await rowsOrCode(c, "select * from site_pages") === "rows=0");
    await asRoot(c);

    console.log("\n3. a signed-in customer cannot modify site_pages");
    for (const a of attempts("customer")) {
      await asUser(c, customer, "aal1");
      const got = await rowsOrCode(c, a.sql);
      await asRoot(c);
      t(`${a.what} → permission denied`, got === "42501", got);
    }
    t("…and every page is still there", (await c.query("select count(*)::int n from site_pages")).rows[0].n === seededPages);
    await asUser(c, customer, "aal1");
    t("a customer cannot create a page through the function either",
      /admin/i.test(await failure(() => c.query("select public.create_page_draft('Nope', 'nope')"))));
    await asRoot(c);

    // ── 4. the page editor's real path ─────────────
    console.log("\n4. the admin page editor still works (SECURITY DEFINER functions + version-table policies)");
    await asAdmin(c, admin);
    const draftId = (await c.query("select public.create_page_draft('Care guide', 'care-guide') v")).rows[0].v as string;
    await asRoot(c);
    const newPage = (await c.query("select page_id from site_page_versions where id = $1", [draftId])).rows[0]?.page_id as string;
    t("create_page_draft makes the page row and its draft", !!newPage && (await c.query("select 1 from site_pages where id = $1", [newPage])).rowCount === 1);
    await asAdmin(c, admin);
    const edited = await c.query("update site_page_versions set title = 'Caring for handloom' where id = $1 returning id", [draftId]);
    t("the admin edits the draft directly (no site_pages grant needed for the foreign key)", edited.rowCount === 1);
    await c.query("select public.publish_one('page', $1)", [newPage]);
    await asRoot(c);
    t("publish_one publishes it", (await c.query("select title from site_page_versions where page_id = $1 and state = 'published'", [newPage])).rows[0]?.title === "Caring for handloom");
    await asAdmin(c, admin);
    const second = (await c.query("select public.ensure_page_draft($1) v", [newPage])).rows[0].v as string;
    await c.query("update site_page_versions set pending_delete = true where id = $1", [second]);
    await c.query("select public.publish_one('page', $1)", [newPage]);
    await asRoot(c);
    t("publishing a pending delete removes the page (site_pages delete, through the function)",
      (await c.query("select 1 from site_pages where id = $1", [newPage])).rowCount === 0);
    await asAdmin(c, admin);
    const third = (await c.query("select public.create_page_draft('Temp', 'temp-page') v")).rows[0].v as string;
    const thirdPage = (await c.query("select page_id from site_page_versions where id = $1", [third])).rows[0].page_id as string;
    await c.query("select public.discard_one('page', $1)", [thirdPage]);
    await asRoot(c);
    t("discard_one discards a never-published page (site_pages delete, through the function)",
      (await c.query("select 1 from site_pages where id = $1", [thirdPage])).rowCount === 0);
    await asAdmin(c, admin);
    const fourth = (await c.query("select public.create_page_draft('Temp 2', 'temp-page-2') v")).rows[0].v as string;
    t("discard_drafts runs for an admin", (await failure(() => c.query("select public.discard_drafts()"))) === "");
    await asRoot(c);
    t("…and removes that never-published page", (await c.query("select 1 from site_page_versions where id = $1", [fourth])).rowCount === 0);

    // ── 5. the server key ─────────────────────────
    console.log("\n5. service_role keeps full access where intended");
    await asService(c);
    t("service_role reads site_pages (RLS bypassed)", (await c.query("select count(*)::int n from site_pages")).rows[0].n === seededPages);
    const sp = await c.query("insert into site_pages default values returning id");
    t("service_role inserts and deletes site_pages", sp.rowCount === 1 &&
      (await c.query("delete from site_pages where id = $1", [sp.rows[0].id])).rowCount === 1);
    t("service_role runs checkout_prices (server-only)", (await failure(() => c.query("select * from public.checkout_prices(array[]::uuid[])"))) === "");
    t("service_role uses the invoice sequence", (await failure(() => c.query("select nextval('invoice_number_seq')"))) === "");
    await asRoot(c);

    // ── 6–7. no accidental breadth; intended access kept ──
    console.log("\n6. no broad anon/authenticated privileges from Supabase defaults");
    const found = await readPosture(c);
    const diffs = comparePostures(readManifest(), found.posture);
    t("the replay matches supabase/security-posture.json exactly", diffs.length === 0, diffs.slice(0, 5).join("; "));
    t("anon/authenticated hold no TRUNCATE, REFERENCES or TRIGGER anywhere", Object.keys(found.nonApiTablePrivileges).length === 0,
      Object.keys(found.nonApiTablePrivileges).slice(0, 5).join(", "));
    t("no API role may CREATE in public", Object.values(found.posture.publicSchemaCreate).every((v) => v === false));
    const P = found.posture;
    const privateTables = ["admin_audit_log", "orders", "profiles", "carts", "coupons", "expenses", "credit_notes", "loyalty_ledger",
      "marketing_sends", "stock_movements", "stock_requests", "style_submissions", "wishlists", "chat_usage",
      "razorpay_webhook_events", "schema_migrations", "ai_daily_spend", "ai_spend_reservations", "coupon_redemptions"];
    t("anon holds nothing on any private table", privateTables.every((x) => P.tables[x] && P.tables[x].privileges.anon.length === 0),
      privateTables.filter((x) => P.tables[x]?.privileges.anon.length).join(", "));
    t("anon can write NO table at all", Object.entries(P.tables).every(([, v]) => v.privileges.anon.every((p) => p === "SELECT")));
    t("the sequences are server-only", Object.values(P.sequences).every((s) => !s.anon.length && !s.authenticated.length));
    const serverOnly = ["checkout_prices(uuid[])", "reserve_stock(jsonb,uuid)", "release_stock(jsonb,uuid,text)", "redeem_coupon(text,uuid,text,numeric)",
      "assign_invoice_number(uuid)", "award_loyalty_points(uuid)", "chat_consume(text,integer,interval)", "ai_budget_reserve(numeric,numeric,interval)"];
    t("server-only functions are executable by service_role alone", serverOnly.every((f) => JSON.stringify(P.functions[f]?.execute) === '["service_role"]'),
      serverOnly.filter((f) => JSON.stringify(P.functions[f]?.execute) !== '["service_role"]').join(", "));
    t("admin functions are not executable by anon", ["publish_one(text,uuid,text)", "publish_all()", "create_page_draft(text,text)", "is_admin()", "admin_customers()"]
      .every((f) => P.functions[f] && !P.functions[f].execute.includes("anon")));
    t("every SECURITY DEFINER function pins its search_path", Object.entries(P.functions).every(([, f]) => !f.securityDefiner || !!f.searchPath),
      Object.entries(P.functions).filter(([, f]) => f.securityDefiner && !f.searchPath).map(([k]) => k).join(", "));

    console.log("\n7. intentionally customer-facing access is still granted, explicitly");
    for (const x of ["products", "product_versions", "categories", "category_versions", "product_images", "product_sizes",
      "journal_posts", "journal_versions", "site_content", "site_page_versions", "product_reviews", "product_url_history", "public_style_submissions"]) {
      t(`anon reads ${x}`, P.tables[x]?.privileges.anon.includes("SELECT") === true);
    }
    t("customers manage their own cart and wishlist", ["carts", "wishlists"].every((x) =>
      ["SELECT", "INSERT", "DELETE"].every((p) => P.tables[x].privileges.authenticated.includes(p))));
    t("customers update only their own contact fields on profiles — never is_admin",
      JSON.stringify(P.tables.profiles.columns.authenticated?.UPDATE) ===
      JSON.stringify(["default_address", "default_phone", "email", "full_name", "marketing_consent", "marketing_consent_at"]));
    t("customers write reviews through column grants only", JSON.stringify(P.tables.product_reviews.columns.authenticated?.INSERT) ===
      JSON.stringify(["body", "product_id", "rating", "user_id"]));
    t("admins moderate reviews but cannot write them (0066): no admin INSERT/UPDATE/ALL policy",
      Object.entries(P.policies).filter(([k, v]) => k.startsWith("public.product_reviews.") && ["INSERT", "UPDATE", "ALL"].includes(v.cmd)
        && `${v.using ?? ""}${v.check ?? ""}`.includes("is_admin()")).length === 0);
    for (const f of ["loyalty_balance(uuid)", "loyalty_settings()", "has_purchased(uuid)", "resubmit_style(uuid,text,text)"]) {
      if (P.functions[f]) t(`authenticated executes ${f}`, P.functions[f].execute.includes("authenticated"));
    }
    for (const f of ["resolve_product_path(text)", "product_rating(uuid)", "product_reviews_for(uuid)"]) {
      t(`anon executes ${f} (storefront)`, P.functions[f]?.execute.includes("anon") === true);
    }
    for (const b of ["product-images", "style-gallery"]) t(`bucket ${b} exists and is public`, P.buckets[b]?.public === true);
    // 0073: what customers send is private until approved; style-gallery holds the approved copies.
    t("bucket style-photos exists and is PRIVATE", P.buckets["style-photos"]?.public === false);
    await c.end();

    // ── 8. the baseline is what makes the difference ──
    console.log("\n8. replay ≡ intended posture only WITH the baseline; a careless migration is caught");
    await engine.database("nobaseline", undefined, { baseline: false });
    const nb = await engine.connect("nobaseline");
    const nbDiffs = comparePostures(readManifest(), (await readPosture(nb)).posture);
    t("without the baseline the same migrations do NOT match (Supabase defaults leak through)", nbDiffs.length > 0, `${nbDiffs.length} differences`);
    t("…e.g. anon could then read every order", nbDiffs.some((d) => d.startsWith("tables.orders.privileges.anon")));
    t("…and run server-only checkout_prices", nbDiffs.some((d) => d.startsWith("functions.checkout_prices(uuid[]).execute")));
    await nb.end();

    const f = await engine.connect("w");
    await asRoot(f);
    await f.query(`create table public.zz_future_feature (id int primary key, note text);
      alter table public.zz_future_feature enable row level security;
      create sequence public.zz_future_seq;`);
    t("a new table gets NO anon/authenticated access unless a migration grants it",
      (await f.query(`select bool_or(has_table_privilege(r, 'public.zz_future_feature', p)) v from unnest(array['anon','authenticated']) r,
        unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`)).rows[0].v === false);
    // True of the historic environment (0004 + baseline) only. Production after
    // Supabase's 30 Oct change gives service_role nothing on new tables — see 9.
    t("…while service_role gets it by default (legacy rebuild only)", (await f.query("select has_table_privilege('service_role', 'public.zz_future_feature', 'SELECT, INSERT, UPDATE, DELETE') v")).rows[0].v === true);
    t("a new sequence is server-only", (await f.query("select has_sequence_privilege('authenticated', 'public.zz_future_seq', 'USAGE') v")).rows[0].v === false);
    const caught = comparePostures(readManifest(), (await readPosture(f)).posture);
    t("the posture check flags the new objects until the manifest is regenerated", caught.some((d) => d.startsWith("tables.zz_future_feature")), caught.join("; "));
    await asUser(f, customer, "aal1");
    t("a customer cannot read the new table", await failureCode(() => f.query("select * from public.zz_future_feature")) === "42501");
    await asRoot(f);

    console.log("\n   the baseline refuses an existing database");
    t("re-running it on a built database is refused", /BASELINE_REFUSED/.test(await failure(() => f.query(BASELINE))));
    await f.end();

    // ── 9. Supabase's 30 Oct 2026 Data API change ──
    console.log(`\n9. after Supabase's 30 Oct change: no automatic grants on new objects, for service_role too`);
    const applyAfter = async (db: Client, prefix: string) => {
      for (const file of MIGRATION_FILES.filter((x) => x.slice(0, 4) > prefix)) {
        await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      }
    };
    // legacy:  the rebuild every other section uses (0004 + baseline defaults throughout).
    // rollout: production's path — legacy migrations, then Supabase's change, then any later ones.
    // early:   as if the change had come straight after 0004, to show what leans on 0004's defaults.
    await engine.database("legacy");
    const legacy = await engine.connect("legacy");
    await engine.database("rollout", LAST_LEGACY_MIGRATION);
    const rollout = await engine.connect("rollout");
    await rollout.query(SUPABASE_30_OCT);
    await applyAfter(rollout, LAST_LEGACY_MIGRATION);
    await engine.database("early", "0004");
    const early = await engine.connect("early");
    await early.query(SUPABASE_30_OCT);
    await applyAfter(early, "0004");
    const postureOf = async (db: Client) => (await readPosture(db)).posture;

    const leftToApiRoles = (await rollout.query(`
      select string_agg(d.defaclobjtype::text || ':' || g.rolname || ':' || a.privilege_type, ', ') v
        from pg_default_acl d, aclexplode(d.defaclacl) a join pg_roles g on g.oid = a.grantee
       where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
         and g.rolname in ('anon', 'authenticated', 'service_role')
         and ((d.defaclobjtype = 'r' and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
           or (d.defaclobjtype = 'S' and a.privilege_type in ('USAGE', 'SELECT')))`)).rows[0].v;
    t("the modelled change leaves no API role a default SELECT/INSERT/UPDATE/DELETE on tables or USAGE/SELECT on sequences",
      leftToApiRoles === null, leftToApiRoles ?? "");
    const rolloutDiffs = comparePostures(readManifest(), await postureOf(rollout));
    t("existing objects keep exactly their privileges (rollout ≡ supabase/security-posture.json)", rolloutDiffs.length === 0,
      rolloutDiffs.slice(0, 5).join("; "));
    const laterDiffs = comparePostures(await postureOf(legacy), await postureOf(rollout));
    t(`migrations after ${LAST_LEGACY_MIGRATION} come out the same with or without the change`, laterDiffs.length === 0,
      laterDiffs.slice(0, 5).join("; "));
    const later = MIGRATION_FILES.filter((x) => x.slice(0, 4) > LAST_LEGACY_MIGRATION);
    const textProblems = later.flatMap((x) => grantDecisionProblems(fs.readFileSync(path.join(MIGRATIONS_DIR, x), "utf8")).map((p) => `${x}: ${p}`));
    t(`migrations after ${LAST_LEGACY_MIGRATION} state an explicit grant decision for every new object (${later.length} checked)`,
      textProblems.length === 0, textProblems.join("; "));

    console.log("\n   historic exceptions: service_role access that only 0004's default privileges create");
    const leaning = differingPaths(await postureOf(legacy), await postureOf(early));
    const unlisted = leaning.filter((p) => !LEGACY_IMPLICIT_SERVICE_ROLE.includes(p));
    const stale = LEGACY_IMPLICIT_SERVICE_ROLE.filter((p) => !leaning.includes(p));
    t(`exactly the ${LEGACY_IMPLICIT_SERVICE_ROLE.length} recorded legacy objects lean on default privileges`,
      unlisted.length === 0 && stale.length === 0,
      [unlisted.length ? `NEW: ${unlisted.join(", ")}` : "", stale.length ? `no longer leaning (shorten the list): ${stale.join(", ")}` : ""].filter(Boolean).join("; "));
    t("they are all service_role access — anon/authenticated never relied on defaults", leaning.every((p) => p.endsWith(".service_role")));
    t("the legacy rebuild still hands service_role every new table by default (why a plain replay proves nothing about 30 Oct)",
      (await legacy.query(`select bool_or(a.privilege_type = 'INSERT') v from pg_default_acl d, aclexplode(d.defaclacl) a
        where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'
          and a.grantee = 'service_role'::regrole`)).rows[0].v === true);

    // A representative compliant migration: one server-only table with its own
    // sequence, one customer table (identity column), one table no API role reaches.
    const COMPLIANT = `
      create sequence public.zz_job_seq;
      revoke all on sequence public.zz_job_seq from anon, authenticated, service_role;
      grant usage on sequence public.zz_job_seq to service_role;
      create table public.zz_server_job (id bigint primary key default nextval('public.zz_job_seq'), note text);
      alter table public.zz_server_job enable row level security;
      revoke all on table public.zz_server_job from anon, authenticated, service_role;
      grant select, insert on table public.zz_server_job to service_role;

      create table public.zz_customer_note (id bigint generated always as identity primary key,
        user_id uuid not null default auth.uid(), note text);
      alter table public.zz_customer_note enable row level security;
      revoke all on table public.zz_customer_note from anon, authenticated, service_role;
      revoke all on sequence public.zz_customer_note_id_seq from anon, authenticated, service_role;
      grant select, insert (note) on table public.zz_customer_note to authenticated;
      grant select on table public.zz_customer_note to service_role;
      create policy "own notes" on public.zz_customer_note for select to authenticated using (user_id = auth.uid());
      create policy "add own notes" on public.zz_customer_note for insert to authenticated with check (user_id = auth.uid());

      create table public.zz_internal (id int primary key);
      alter table public.zz_internal enable row level security;
      revoke all on table public.zz_internal from anon, authenticated, service_role;`;
    const CARELESS = `
      create table public.zz_careless (id bigint generated by default as identity primary key, note text);
      alter table public.zz_careless enable row level security;
      create sequence public.zz_careless_seq;`;

    console.log("\n   a compliant new migration: explicit, minimal grants");
    t("the text rule accepts it", grantDecisionProblems(COMPLIANT).length === 0, grantDecisionProblems(COMPLIANT).join("; "));
    for (const db of [legacy, rollout]) await db.query(COMPLIANT);
    const compliantDiffs = comparePostures(await postureOf(legacy), await postureOf(rollout));
    t("it produces the same privileges under the old and the new defaults", compliantDiffs.length === 0, compliantDiffs.slice(0, 5).join("; "));

    const r = rollout;
    await asRoot(r);
    const noteOwner = (await r.query("insert into auth.users (email) values ('notes@example.test') returning id")).rows[0].id as string;
    const otherUser = (await r.query("insert into auth.users (email) values ('other@example.test') returning id")).rows[0].id as string;
    await r.query("insert into public.zz_customer_note (user_id, note) values ($1, 'not yours')", [otherUser]);
    const as = async (who: "anon" | "customer" | "service", sql: string, args: unknown[] = []) => {
      if (who === "anon") await r.query("set role anon");
      else if (who === "customer") await asUser(r, noteOwner, "aal1");
      else await asService(r);
      try {
        return await failureCode(() => r.query(sql, args));
      } finally {
        await asRoot(r);
      }
    };
    t("service_role inserts a server job — the sequence default works through its USAGE grant",
      await as("service", "insert into public.zz_server_job (note) values ('ok')") === "");
    t("service_role reads it back", await as("service", "select * from public.zz_server_job") === "");
    t("…but cannot update or delete it (granted select, insert only)",
      await as("service", "update public.zz_server_job set note = 'x'") === "42501" &&
      await as("service", "delete from public.zz_server_job") === "42501");
    t("anon and a customer cannot read the server-only table",
      await as("anon", "select * from public.zz_server_job") === "42501" && await as("customer", "select * from public.zz_server_job") === "42501");
    t("anon and a customer cannot draw from the server-only sequence",
      await as("anon", "select nextval('public.zz_job_seq')") === "42501" && await as("customer", "select nextval('public.zz_job_seq')") === "42501");
    t("a customer adds a note (identity column needs no sequence grant)",
      await as("customer", "insert into public.zz_customer_note (note) values ('mine')") === "");
    await asUser(r, noteOwner, "aal1");
    const visible = (await r.query("select note from public.zz_customer_note")).rows.map((x) => x.note).join(",");
    await asRoot(r);
    t("…and sees only their own (RLS decides the rows the grant opens)", visible === "mine", visible);
    t("a customer cannot write someone else's user_id (column grant: note only)",
      await as("customer", "insert into public.zz_customer_note (user_id, note) values ($1, 'forged')", [otherUser]) === "42501");
    t("a customer cannot update or delete notes (not granted)",
      await as("customer", "update public.zz_customer_note set note = 'x'") === "42501" &&
      await as("customer", "delete from public.zz_customer_note") === "42501");
    t("anon cannot read customer notes", await as("anon", "select * from public.zz_customer_note") === "42501");
    t("service_role reads every note (RLS bypassed) but cannot insert one (granted select only)",
      await as("service", "select * from public.zz_customer_note") === "" &&
      await as("service", "insert into public.zz_customer_note (user_id, note) values ($1, 'x')", [otherUser]) === "42501");
    const internal: string[] = [];
    for (const w of ["anon", "customer", "service"] as const) internal.push(await as(w, "select * from public.zz_internal"));
    t("no API role reaches the deliberately internal table", internal.every((x) => x === "42501"), internal.join(","));

    console.log("\n   a careless new migration that relies on automatic grants is caught");
    for (const db of [legacy, rollout]) await db.query(CARELESS);
    const carelessText = grantDecisionProblems(CARELESS);
    t("the text rule rejects it (table and sequence)",
      carelessText.includes("table zz_careless: no explicit grant or revoke for anon, authenticated, service_role") &&
      carelessText.includes("sequence zz_careless_seq: no explicit grant or revoke for anon, authenticated, service_role"), carelessText.join("; "));
    const carelessDiffs = differingPaths(await postureOf(legacy), await postureOf(rollout));
    t("the legacy rebuild and the post-change database disagree on it", carelessDiffs.includes("tables.zz_careless.privileges.service_role") &&
      carelessDiffs.includes("sequences.zz_careless_seq.service_role"), carelessDiffs.join(", "));
    t("the legacy rebuild alone would have let it through: there service_role gets the table by default",
      (await legacy.query("select has_table_privilege('service_role', 'public.zz_careless', 'SELECT, INSERT, UPDATE, DELETE') v")).rows[0].v === true);
    t("after the change no API role holds SELECT/INSERT/UPDATE/DELETE on it",
      (await rollout.query(`select bool_or(has_table_privilege(x, 'public.zz_careless', p)) v from unnest(array['anon','authenticated','service_role']) x,
        unnest(array['SELECT','INSERT','UPDATE','DELETE']) p`)).rows[0].v === false);
    t("…so the server key's insert fails with 42501 — the production failure this rule prevents",
      await as("service", "insert into public.zz_careless (note) values ('x')") === "42501");
    t("…and a customer's read fails too", await as("customer", "select * from public.zz_careless") === "42501");
    t("no API role holds USAGE or SELECT on the new sequence",
      (await rollout.query(`select bool_or(has_sequence_privilege(x, 'public.zz_careless_seq', p)) v from unnest(array['anon','authenticated','service_role']) x,
        unnest(array['USAGE','SELECT']) p`)).rows[0].v === false);
    t("anon cannot draw from it", await as("anon", "select nextval('public.zz_careless_seq')") === "42501");

    for (const db of [legacy, rollout, early]) await db.end();
  } finally {
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

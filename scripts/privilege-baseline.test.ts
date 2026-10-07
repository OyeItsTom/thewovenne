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

async function rowsOrCode(c: Client, sql: string): Promise<string> {
  try {
    const r = await c.query(sql);
    return `rows=${r.rowCount}`;
  } catch (e) {
    return String((e as { code?: string }).code ?? "error");
  }
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
    for (const b of ["product-images", "style-photos"]) t(`bucket ${b} exists and is public`, P.buckets[b]?.public === true);
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
    t("…while service_role gets it by default", (await f.query("select has_table_privilege('service_role', 'public.zz_future_feature', 'SELECT, INSERT, UPDATE, DELETE') v")).rows[0].v === true);
    t("a new sequence is server-only", (await f.query("select has_sequence_privilege('authenticated', 'public.zz_future_seq', 'USAGE') v")).rows[0].v === false);
    const caught = comparePostures(readManifest(), (await readPosture(f)).posture);
    t("the posture check flags the new objects until the manifest is regenerated", caught.some((d) => d.startsWith("tables.zz_future_feature")), caught.join("; "));
    await asUser(f, customer, "aal1");
    t("a customer cannot read the new table", await failureCode(() => f.query("select * from public.zz_future_feature")) === "42501");
    await asRoot(f);

    console.log("\n   the baseline refuses an existing database");
    t("re-running it on a built database is refused", /BASELINE_REFUSED/.test(await failure(() => f.query(BASELINE))));
    await f.end();
  } finally {
    await engine.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

# Database

Ordered migrations in `migrations/`, applied **in number order**, after a
one-time privilege baseline (`bootstrap/privilege_baseline.sql`). Read
"Setting up a new project" before building any new database — production,
staging, disaster recovery or local.

## Setting up a new project

1. **Create the Supabase project.** Nothing else in it yet.
2. **Establish the Wovenne privilege baseline — before any migration.** Run
   [`bootstrap/privilege_baseline.sql`](bootstrap/privilege_baseline.sql) once,
   as `postgres` (the SQL editor's role, or `psql` on the direct connection).
   It ends with a self-check and prints postgres's default privileges in
   `public`: anon/authenticated get nothing, service_role gets everything. It
   refuses to run on a database that already has Wovenne tables. **Skipping it
   produces a database that looks right and is not** — see "Privilege baseline".
3. **Run every migration in number order**, `0001` to the newest, as
   `postgres`. Prefer the runner, which applies each file in one transaction,
   prints its verify block and records it in `schema_migrations` (0057):
   `node scripts/run-migration.mjs supabase/migrations/0001_core_tables.sql`,
   and so on — it connects to `SUPABASE_DB_URL` from `.env.local`, so check
   that names the NEW project. Pasting files
   into the SQL editor also works; the ledger then only knows what 0057
   backfilled. Run `0008` as it stands — it promotes nobody until step 5. Skip
   `0007` if you don't want the placeholder catalogue (see below).
4. **Verify schema and security**, from a checkout with `.env.local` pointing
   at the new project:
   `npx tsx scripts/security-posture.ts --production` (read-only; despite the
   flag name it checks whichever database `SUPABASE_DB_URL` names). It
   compares RLS, every policy, and every anon/authenticated/service_role
   privilege on Wovenne's objects with
   [`security-posture.json`](security-posture.json) and must say **MATCHES**.
   A difference means a step above was skipped or ran as the wrong role.
5. **Create the admin.** Authentication → Users → Add user (email +
   password); the `on_auth_user_created` trigger (0023) makes the profile. Then
   run the `update` in [`0008_promote_admin.sql`](migrations/0008_promote_admin.sql)
   with that email — expect one row. Sign in at `/admin`: admin authority needs
   a two-factor session (0062), so the first sign-in goes through `/admin/mfa`
   to enrol an authenticator app. Until then the account is staff with no
   admin powers.

## Privilege baseline

The Wovenne production project never had Supabase's usual broad default grants
for `anon` and `authenticated` (`0004` records the symptom: even
`service_role` had to be granted explicitly). **Every migration was written
against that restricted posture**: API access is granted explicitly where a
feature needs it, and functions are often restricted with
`revoke … from public` — which removes nothing on a standard Supabase project,
where anon and authenticated hold their own grants rather than PUBLIC's.

The 5 October 2026 production-vs-replay audit proved it: replayed on a standard
project, the migrations gave anon/authenticated extra grants on 28 tables and
35 functions — anon could read `orders`, run the server-only
`checkout_prices`, and so on. Replayed after the baseline, they reproduce
production's grants, policies, functions and triggers exactly.

What the baseline sets — default privileges of role `postgres` in schema
`public` only, i.e. what objects created later start with:

| | new tables | new sequences | new functions |
|---|---|---|---|
| anon, authenticated | nothing | nothing | PostgreSQL's built-in EXECUTE via PUBLIC (as in production) |
| service_role | everything | everything | everything |

It does not touch Supabase-managed schemas, `supabase_admin`'s default
privileges, or global default privileges (it stops if one of those would
defeat it). Run migrations as `postgres`; objects created by another role do
not get these defaults.

**Rules for new migrations:**

- Assume **no access, for every API role — `service_role` included** (see
  "Supabase's 30 October 2026 Data API change" below). Every new table, view
  and sequence in `public` gets its grant decision in the same migration,
  written so the result does not depend on any default privileges:

  ```sql
  revoke all on table public.x from anon, authenticated, service_role;
  grant select, insert on table public.x to service_role;  -- only what a real caller does
  ```

  - `anon` / `authenticated`: grant only what the browser or a signed-in
    customer actually does through the Data API, column-level where it matters
    (e.g. `profiles`, `product_reviews`). Never `grant all` to either.
  - `service_role`: grant only what a trusted server workflow
    (`createServiceClient()`) actually does. A table no server code touches
    through the Data API gets nothing.
  - **No Data API access at all** is a valid decision — the `revoke all` line
    alone, as for the analytics tables reached only by functions and cron.
  - **Sequences**, including the one an `identity` or `serial` column creates
    (`pg_get_serial_sequence('public.x', 'id')` names it): `revoke all … from
    anon, authenticated, service_role` too. Grant `usage` only to a role that
    inserts through a `default nextval(…)`; an `identity` column needs no
    sequence grant.
- `GRANT` decides whether a role reaches a table through the Data API at all;
  RLS decides which rows. A grant without RLS exposes every row; RLS without a
  grant returns `42501`. `service_role` bypasses RLS, so its grant is the only
  limit on it. Direct database connections (`SUPABASE_DB_URL`, used only by
  `scripts/`) bypass the Data API entirely — they never justify a grant to an
  API role.
- Enable RLS on every new table, even one only functions touch (`site_pages`,
  0064, is the lesson: RLS off plus a stray grant is a hole).
- A new function is executable by everyone through PUBLIC unless the migration
  says `revoke execute … from public` and grants the roles that need it.
- Regenerate the posture manifest in the same change:
  `PG_HARNESS_DIR=… npx tsx scripts/security-posture.ts --replay --write`, and
  review its diff — it is exactly what the migration changes about who can do
  what. `scripts/privilege-baseline.test.ts` fails until you do. After applying
  to production, `--production` must say MATCHES.

Production differs from the baseline in one known way: its project defaults
also give anon/authenticated TRUNCATE, REFERENCES and TRIGGER (and
MAINTAIN) on tables created without an explicit `revoke all`. None is
reachable through the Data API and nothing uses them; `security-posture.ts`
reports them separately and does not compare them. Removing them from
production is a separate, reviewed change.

The test databases (`scripts/pg-world.ts`) are built the same way: a standard
Supabase project's grants, then this baseline, then the migrations.

## Supabase's 30 October 2026 Data API change

From 30 October 2026 Supabase stops granting `select, insert, update, delete`
on new `public` tables, and `usage, select` on new sequences, to `anon`,
`authenticated` **and `service_role`** (changelog 45329; it alters the default
privileges of role `postgres` in `public`). Existing objects keep their grants.

For Wovenne, `anon`/`authenticated` already work this way (above). The change
that matters is **`service_role`: a new table without an explicit grant is
unreachable by server code** — every `createServiceClient()` call on it fails
with `42501`.

**Why 0004 is not proof that a new migration is safe.** `0004` runs
`alter default privileges … grant all on tables to service_role`, and the
baseline does the same, so every rebuild — the posture replay included — still
hands `service_role` each new table by default. A migration that forgets
`service_role` passes the replay and fails in production.
`scripts/privilege-baseline.test.ts` section 9 closes that gap: it builds a
database with Supabase's statements applied after `0073` (production's path)
and requires every later migration to produce exactly the same privileges as
the plain rebuild, and to state its decision in text: for each new table, view
or sequence, a `grant` or `revoke` naming each of `anon`, `authenticated` and
`service_role`, and RLS on for tables.

**Historic exceptions.** These objects, created after `0004`, get their
`service_role` access only from those default privileges. Production holds it
and keeps it; a rebuild re-creates it through `0004`. Section 9 pins this exact
list — nothing may be added:
`coupon_redemptions`, `coupons`, `credit_notes`, `expenses`,
`public_style_submissions` (view), `razorpay_webhook_events` (beyond its
explicit insert/select), `schema_migrations`, `stock_movements`,
`stock_requests` (beyond its explicit select), `style_submissions`, and the
sequences `analytics_events_id_seq`, `credit_note_number_seq`,
`invoice_number_seq`.

**Production before the rollout (measured 21 October 2026, about 18:47
UTC, read-only, PostgreSQL 17.6, ledger at `0073`).** `pg_default_acl` for
`postgres` in `public`:

| | `service_role` | `anon` / `authenticated` |
|---|---|---|
| tables | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (the legacy automatic grant) | no SELECT/INSERT/UPDATE/DELETE; legacy TRUNCATE, REFERENCES, TRIGGER, MAINTAIN |
| sequences | SELECT, UPDATE, USAGE | nothing |

The 13 historic exceptions above hold their intended `service_role`
privileges. `security-posture.ts --production` said MATCHES: 40
tables/views, 105 functions, 75 RLS policies and 4 sequences. That check
covers existing objects only. It never compares default ACLs, or the
TRUNCATE/REFERENCES/TRIGGER grants held by `anon`/`authenticated`, so the
default ACL was read separately with:

```sql
begin transaction read only;
select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl
  from pg_default_acl
 where defaclrole = 'postgres'::regrole and defaclnamespace in (0, 'public'::regnamespace);
rollback;
```

**Not yet verified:** that Supabase's rollout has reached this project, and
how it treats these non-standard defaults. After 30 October, repeat both
checks read-only. `security-posture.ts --production` must still say
MATCHES. The query above should show `service_role` without
SELECT/INSERT/UPDATE/DELETE on tables and without USAGE/SELECT on
sequences. If it still shows them, the rollout has not reached the project.

## The files

| File | What it does |
|---|---|
| `0001_core_tables.sql` | categories, products, orders, site_content, journal_posts |
| `0002_admin_identity.sql` | `profiles` + `is_admin()` — everything below depends on it |
| `0003_row_level_security.sql` | Public read policies, admin-only writes |
| `0004_grants.sql` | Base privileges for `anon`, `authenticated`, `service_role` |
| `0005_storage.sql` | `product-images` bucket + policies |
| `0006_product_images.sql` | Multi-photo galleries |
| `0007_seed.sql` | Categories, placeholder products, homepage copy, journal posts — **do not re-run on production**, see below |
| `0008_promote_admin.sql` | **Manual.** Makes you an admin — edit the email first |
| `0009_admin_audit_log.sql` | Records who changed what, via database triggers |
| `0010_site_content_drafts.sql` | Draft/publish for homepage copy |
| `0011_versioning_schema.sql` | Draft/published versions for products, categories, journal |
| `0012_draft_helpers.sql` | Copy-on-write draft creation + pending count |
| `0013_publish.sql` | `publish_all()` / `discard_drafts()` |
| `0014_audit_versions.sql` | Moves the audit triggers onto the version tables |
| `0015_site_pages.sql` | Editable content pages (About, FAQ, …) + seeds five |
| `0016` … | Each file's header comment says what it does and why |
| `0064_site_pages_row_level_security.sql` | RLS on `site_pages`; no direct API writes (production already had RLS on) |

Every file is idempotent: `create … if not exists`, `drop policy if exists`
before each policy, `on conflict do nothing` on every seed. Re-running any of
them on a populated database is safe. Skip `0007` if you don't want the
placeholder catalogue.

## Why these are split

They replace a single 418-line `schema.sql`. That file stopped being runnable —
a failure anywhere aborted every statement after it, and because the Supabase
SQL editor reports only the first error, it was impossible to tell how far it
had got. The production database ended up built from hand-pasted fragments, so
the file no longer described it.

Smaller files fail visibly and can be re-run individually. The split was
verified statement-by-statement against the retired `schema.sql`: 113
statements in, 113 out, none lost, duplicated or invented.

## Gotchas

**`0002` does not create a trigger on `auth.users`; `0023` does.** `0002`
left `handle_new_user()` unwired because creating a trigger on `auth.users`
needs a privilege the SQL-editor role might lack. `0023` wires it
(`on_auth_user_created`), and production has it.

**`0008` is not optional.** Nothing else promotes anyone. Skip it and `/admin`
lets you sign in, then shows an empty dashboard, because every admin policy
returns false and `lib/auth.ts` fails closed.

**`0007` is no longer safe on production.** Its ten placeholder products were
deleted on 2026-07-30 once real products existed. `on conflict do nothing` only
protects rows that still exist — those slugs are free again, so re-running the
file would resurrect all ten with `placehold.co` covers that Next's optimizer
rejects, putting ten broken products back on the live shop. The categories and
`site_content` blocks in that file are still safe to re-run.

**`service_role` grants in `0004` matter more than they look.** Supabase's
defaults were not in place on this project, so every `service_role` query
failed with `42501` — which silently broke order recording, since the Razorpay
route writes the order with that key after verifying the payment signature. The privilege baseline now grants service_role
by default too; 0004's explicit grants stay, harmlessly. Those defaults cover
rebuilds only: from 30 October 2026 production gives new tables nothing, so a
new migration grants `service_role` explicitly (see the Data API change above).

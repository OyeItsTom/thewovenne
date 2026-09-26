-- Is production what migration 0060 was tested against? — READ ONLY
--
-- One SELECT, for the owner to run in the Supabase SQL Editor BEFORE 0060 is
-- approved (see PR #160). It writes nothing: no table, ledger or privilege is
-- touched, and the tests run it inside `begin read only`. Every row is one
-- check with its own verdict:
--
--   PASS     production matches what 0060 was built and tested against
--   REVIEW   a difference to understand before approving — not automatically
--            fatal, never automatically fine
--   BLOCKER  do not apply 0060 until this is resolved
--
-- Any row that returns NULL where a value was expected is a BLOCKER by
-- construction: an unknown is never a pass.
--
-- The output holds role, schema, function and table names, versions and
-- counts. It holds no credentials, customer data, order data or query text.
--
-- migration_role is the role scripts/run-migration.mjs connects as — the user
-- in SUPABASE_DB_URL, which for this project is `postgres`.

with params as (
  select 'postgres'::text as migration_role
),
-- Functions 0060 replaces or re-configures, with the md5 of their body as the
-- repository's migrations 0001–0059 leave it. A mismatch means production's
-- copy was changed outside the migrations.
expected_fns (sig, body_md5) as (values
  ('cancel_order(uuid,text)', '7592dc1829b122df0ff17eea8892f030'),
  ('checkout_prices(uuid[])', '0623afc5bdb122e1fe8235239f0b288a'),
  ('create_product_draft()', '8736aa9982d597d178aab2d29acfa002'),
  ('derive_version_stock()', '0e5ce6b724677b0aa10a300f36a3b728'),
  ('discard_drafts()', 'ea21084a405e192d084a16f634073762'),
  ('discard_one(text,uuid,text)', '04cbd446aeedff75342d64c2a15229f8'),
  ('draft_is_noop(text,uuid)', '273d05675658b8b54968f5ef94d7448c'),
  ('ensure_product_draft(uuid)', '4db50811317296cdc9ab4d2db312b3fb'),
  ('gallery_matches(uuid,uuid)', '2116232430f746dbc96e4868b913ceff'),
  ('is_admin()', 'cce55c471903ab02d7e267a377ef34e8'),
  ('issue_credit_note(uuid,text,numeric,text,jsonb)', '29862d094328f32238e8f4da34cb66be'),
  ('log_admin_action()', '874e20bfc64ef8fed5457a8f1f72111c'),
  ('orders_cancel_needs_credit_note()', '1705ab3aef446c78b98fba3161ec0e6a'),
  ('pending_changes()', '74b02b574e671ef8ea1c11f72f0095a1'),
  ('pending_queue()', '04af1b77b63ab151b0ee53511af06ff5'),
  ('product_path(uuid)', '414ecd99ec97abb7ea6626efbeaba74e'),
  ('product_size_total(uuid)', '662db38aae5071c45a11ef058060d8d6'),
  ('publish_all()', '49f86b53c69117133cb692be19028889'),
  ('publish_one(text,uuid,text)', 'e71b5a1a5dca4a91f17445550c3bd4ca'),
  ('record_product_path()', 'b2e2fbd19338a81d7d5913dce7a5612c'),
  ('release_stock(jsonb,uuid,text)', '32783030885b29d0072b4e04a66dc231'),
  ('require_images_to_publish()', 'd23d0a398bc71194044f3bfba3575cbe'),
  ('reserve_stock(jsonb,uuid)', '2463d1672289aedc380268c2c0f0d593'),
  ('resync_versions_from_sizes()', '5028261ad64e10691cd9ce5d638eafc0'),
  ('save_product_sizes(uuid,jsonb,text)', 'a7149b0353d8415f6bfed523b9f3d3d7'),
  ('settle_draft(text,uuid)', 'f200d2db64b6eaed0f0d08d15b9bb00f'),
  ('sync_published_product_extras()', '3695164cf9babff47ed0226abaeacacc'),
  ('validate_publish()', '875665b3a1d70794b290e27d34964761'),
  ('version_noise()', '308bc70f082bc04c1cdb6e4dd3175426')
),
fns as (
  select e.sig, e.body_md5 as expected_md5, p.oid, md5(p.prosrc) as actual_md5,
         pg_get_userbyid(p.proowner) as owner
    from expected_fns e
    left join pg_proc p
      on p.pronamespace = 'public'::regnamespace
     -- name(types), independent of the session's search_path
     and p.proname || '(' || replace(oidvectortypes(p.proargtypes), ', ', ',') || ')' = e.sig
),
-- Tables 0060 alters, triggers on, revokes on, or references.
touched_tables (t) as (values
  ('products'), ('product_versions'), ('product_sizes'), ('stock_movements'), ('orders')
),
expected_triggers (tbl, tg) as (values
  ('product_versions', 'audit_product_versions'),
  ('product_versions', 'derive_stock_from_sizes'),
  ('product_versions', 'record_product_path_trigger'),
  ('product_versions', 'require_images_before_publish'),
  ('product_versions', 'sync_product_extras'),
  ('product_sizes',    'resync_stock_from_sizes'),
  ('orders',           'orders_cancel_guard')
),
actual_triggers as (
  select c.relname as tbl, t.tgname as tg
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
     and c.relname in ('products', 'product_versions', 'product_sizes', 'stock_movements', 'orders')
),
expected_columns (tbl, col) as (values
  ('stock_movements', 'product_id'), ('stock_movements', 'size_label'), ('stock_movements', 'delta'),
  ('stock_movements', 'reason'), ('stock_movements', 'order_id'), ('stock_movements', 'note'),
  ('stock_movements', 'actor_id'), ('stock_movements', 'created_at'),
  ('product_sizes', 'id'), ('product_sizes', 'product_id'), ('product_sizes', 'label'),
  ('product_sizes', 'stock_quantity'), ('product_sizes', 'sort_order'),
  ('product_versions', 'id'), ('product_versions', 'product_id'), ('product_versions', 'state'),
  ('product_versions', 'stock_quantity'), ('product_versions', 'pending_delete'),
  ('product_versions', 'published_at'), ('product_versions', 'version'),
  ('products', 'id'), ('products', 'stock_quantity'), ('products', 'slug'),
  ('orders', 'items'), ('orders', 'status'), ('orders', 'payment_status'),
  ('orders', 'total_inr'), ('orders', 'cancelled_at'),
  ('profiles', 'is_admin'),
  ('schema_migrations', 'filename'), ('schema_migrations', 'applied_at')
),
schema_acl as (
  select a.grantee, a.grantor, a.privilege_type
    from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
   where n.nspname = 'public'
),
checks (id, what, observed, expected, verdict, if_not_pass) as (

  -- ── The server ─────────────────────────────
  select 'P01', 'PostgreSQL version',
         current_setting('server_version'),
         '13 or later (tested on 18.4)',
         case when current_setting('server_version_num')::int >= 130000 then 'PASS' else 'BLOCKER' end,
         'Older than every version the migration was reasoned or tested against.'

  union all
  select 'P02', 'Migration role exists and is not an API role',
         (select string_agg(rolname || case when rolsuper then ' (superuser)' else ' (not superuser)' end
                            || case when rolbypassrls then ', bypassrls' else '' end, ', ')
            from pg_roles where rolname = (select migration_role from params)),
         'postgres, not superuser (Supabase) — both forms were tested',
         case when exists (select 1 from pg_roles where rolname = (select migration_role from params))
              then 'PASS' else 'BLOCKER' end,
         'The role scripts/run-migration.mjs connects as does not exist here: this is not the database the runner will reach.'

  union all
  select 'P03', 'API roles exist',
         (select string_agg(rolname, ', ' order by rolname) from pg_roles
           where rolname in ('anon', 'authenticated', 'service_role')),
         'anon, authenticated, service_role',
         case when (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) = 3
              then 'PASS' else 'BLOCKER' end,
         '0060 grants and revokes by these names; without them it fails.'

  union all
  select 'P04', 'Where unqualified names resolve for this session',
         array_to_string(current_schemas(false), ', '),
         'public first (0060 now pins its own search_path, so this is informational)',
         case when (current_schemas(false))[1] = 'public' then 'PASS' else 'REVIEW' end,
         'Other migrations that do not pin search_path could create objects outside public. 0060 itself is unaffected.'

  -- ── The ledger ─────────────────────────────
  union all
  select 'L01', 'Migration ledger present (0057)',
         case when to_regclass('public.schema_migrations') is null then 'missing' else 'present' end,
         'present',
         case when to_regclass('public.schema_migrations') is null then 'BLOCKER' else 'PASS' end,
         'The runner could not record 0060, and the state of 0001–0059 cannot be read.'

  union all
  select 'L02', '0060 not already recorded',
         (select count(*)::text from schema_migrations where filename like '0060%'),
         '0',
         case when (select count(*) from schema_migrations where filename like '0060%') = 0 then 'PASS' else 'BLOCKER' end,
         '0060 is already recorded as applied. Stop and compare the database with this PR before anything else.'

  union all
  select 'L03', 'Latest recorded migration',
         (select filename || coalesce(' @ ' || applied_at::text, ' (retrospective)')
            from schema_migrations order by filename desc limit 1),
         '0059_ai_daily_spend.sql',
         case when (select max(filename) from schema_migrations) = '0059_ai_daily_spend.sql' then 'PASS'
              when (select max(filename) from schema_migrations) > '0059_ai_daily_spend.sql' then 'BLOCKER'
              else 'REVIEW' end,
         'Later than 0059: something unreviewed was applied. Earlier: 0058/0059 may be missing — the function checks below say whether 0060''s prerequisites exist.'

  union all
  select 'L04', 'Migrations 0001–0059 all recorded',
         (select count(*)::text from schema_migrations where filename ~ '^00[0-5][0-9]_'),
         '59',
         case when (select count(*) from schema_migrations where filename ~ '^00[0-5][0-9]_') = 59 then 'PASS' else 'REVIEW' end,
         'A gap in the ledger. Not fatal by itself if the objects exist (checked below), but it must be explained.'

  -- ── Nothing of 0060 is here yet ────────────
  union all
  select 'N01', 'No 0060 object already exists',
         coalesce(nullif(concat_ws(', ',
           case when to_regclass('public.stock_requests') is not null then 'table stock_requests' end,
           case when to_regprocedure('public.set_product_stock(uuid,integer,integer,uuid,text,text)') is not null then 'set_product_stock' end,
           case when to_regprocedure('public.claim_stock_request(uuid,uuid,text,text)') is not null then 'claim_stock_request' end,
           case when to_regprocedure('public.save_product_sizes(uuid,jsonb,text,uuid)') is not null then 'save_product_sizes(…, uuid)' end,
           case when exists (select 1 from pg_trigger where tgname = 'guard_live_stock') then 'trigger guard_live_stock' end,
           case when exists (select 1 from information_schema.columns where table_schema = 'public'
                              and table_name = 'stock_movements' and column_name = 'request_id') then 'stock_movements.request_id' end
         ), ''), 'none'),
         'none',
         case when to_regclass('public.stock_requests') is null
               and to_regprocedure('public.set_product_stock(uuid,integer,integer,uuid,text,text)') is null
               and to_regprocedure('public.claim_stock_request(uuid,uuid,text,text)') is null
               and to_regprocedure('public.save_product_sizes(uuid,jsonb,text,uuid)') is null
               and not exists (select 1 from pg_trigger where tgname = 'guard_live_stock')
               and not exists (select 1 from information_schema.columns where table_schema = 'public'
                                and table_name = 'stock_movements' and column_name = 'request_id')
              then 'PASS' else 'BLOCKER' end,
         'Part of 0060 exists without a ledger row: it was partly applied by hand. Stop.'

  -- ── What 0060 replaces ─────────────────────
  union all
  select 'F01', 'Every function 0060 replaces or re-configures exists, with the exact signature',
         coalesce((select string_agg(sig, ', ') from fns where oid is null), 'all present'),
         'all present',
         case when not exists (select 1 from fns where oid is null) then 'PASS' else 'BLOCKER' end,
         'The listed functions are missing or have another signature. 0060 would fail on them (safely, all-or-nothing) — but it means production is not the tested schema.'

  union all
  select 'F02', 'Each is owned by the migration role',
         coalesce((select string_agg(sig || ' → ' || owner, ', ') from fns
                    where oid is not null and owner <> (select migration_role from params)), 'all owned by ' || (select migration_role from params)),
         'all owned by postgres',
         case when not exists (select 1 from fns where oid is not null and owner <> (select migration_role from params))
               and not exists (select 1 from fns where oid is null) then 'PASS' else 'BLOCKER' end,
         'CREATE OR REPLACE and ALTER FUNCTION need ownership. 0060 would stop with "must be owner" (tested) and apply nothing.'

  union all
  select 'F03', 'Each body is exactly what migrations 0001–0059 left',
         coalesce((select string_agg(sig, ', ') from fns where oid is not null and actual_md5 <> expected_md5), 'all match'),
         'all match',
         case when not exists (select 1 from fns where oid is not null and actual_md5 <> expected_md5) then 'PASS' else 'REVIEW' end,
         'Changed outside the migrations. The replaced ones are overwritten by 0060; the re-configured ones (is_admin, log_admin_action, record_product_path, product_path, require_images_to_publish, sync_published_product_extras, orders_cancel_needs_credit_note, issue_credit_note, validate_publish, the draft helpers, checkout_prices) keep their bodies — and those bodies were not the ones tested.'

  union all
  select 'F04', 'No extra overloads of the stock functions',
         (select string_agg(p.proname || '(' || replace(oidvectortypes(p.proargtypes), ', ', ',') || ')', ', ') from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('reserve_stock', 'release_stock', 'save_product_sizes', 'publish_one', 'publish_all', 'cancel_order')),
         'exactly one each: reserve_stock(jsonb,uuid), release_stock(jsonb,uuid,text), save_product_sizes(uuid,jsonb,text), publish_one(text,uuid,text), publish_all(), cancel_order(uuid,text)',
         case when (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
                     and p.proname in ('reserve_stock', 'release_stock', 'save_product_sizes', 'publish_one', 'publish_all', 'cancel_order')) = 6
              then 'PASS' else 'BLOCKER' end,
         'An overload 0060 does not replace would stay callable with the old behaviour.'

  -- ── Current grants (0060 changes these) ────
  union all
  select 'G01', 'Current EXECUTE grants (anon / authenticated / service_role)',
         (select string_agg(x.sig || '=' ||
                   case when has_function_privilege('anon', x.sig, 'EXECUTE') then 'A' else '-' end ||
                   case when has_function_privilege('authenticated', x.sig, 'EXECUTE') then 'U' else '-' end ||
                   case when has_function_privilege('service_role', x.sig, 'EXECUTE') then 'S' else '-' end, ', ')
            from (values ('public.reserve_stock(jsonb,uuid)'), ('public.release_stock(jsonb,uuid,text)'),
                         ('public.cancel_order(uuid,text)'), ('public.publish_one(text,uuid,text)'),
                         ('public.publish_all()'), ('public.save_product_sizes(uuid,jsonb,text)')) x(sig)
           where to_regprocedure(x.sig) is not null),
         'reserve/release = --S (0058); others: U and S present. anon may be present; 0060 removes it',
         case when not has_function_privilege('authenticated', 'public.reserve_stock(jsonb,uuid)', 'EXECUTE')
               and not has_function_privilege('authenticated', 'public.release_stock(jsonb,uuid,text)', 'EXECUTE')
               and has_function_privilege('service_role', 'public.reserve_stock(jsonb,uuid)', 'EXECUTE')
              then 'PASS' else 'REVIEW' end,
         'reserve/release reachable by signed-in users today (0058 revoked that), or checkout''s service role cannot call them. 0060 re-asserts both; find out how it drifted.'

  union all
  select 'G02', 'Grants 0060 must revoke were made by the migration role (or the owner)',
         coalesce((
           select string_agg(distinct format('%s on %s granted by %s', a.privilege_type, x.obj, pg_get_userbyid(a.grantor)), '; ')
             from (
               select 'public.product_sizes' obj, c.relacl acl, c.relowner own from pg_class c where c.oid = to_regclass('public.product_sizes')
               union all select 'public.stock_movements', c.relacl, c.relowner from pg_class c where c.oid = to_regclass('public.stock_movements')
               union all select p.oid::regprocedure::text, p.proacl, p.proowner from pg_proc p
                 where p.pronamespace = 'public'::regnamespace
                   and p.proname in ('reserve_stock', 'release_stock', 'publish_one', 'publish_all', 'cancel_order', 'save_product_sizes')
             ) x, aclexplode(coalesce(x.acl, acldefault((case when x.obj like '%(%' then 'f' else 'r' end)::"char", x.own))) a
            where (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
              and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'EXECUTE')
              and pg_get_userbyid(a.grantor) not in ((select migration_role from params), pg_get_userbyid(x.own))
         ), 'none from another grantor'),
         'none from another grantor',
         case when exists (
           select 1
             from (
               select c.relacl acl, c.relowner own, 'r' k from pg_class c where c.oid in (to_regclass('public.product_sizes'), to_regclass('public.stock_movements'))
               union all select p.proacl, p.proowner, 'f' from pg_proc p
                 where p.pronamespace = 'public'::regnamespace
                   and p.proname in ('reserve_stock', 'release_stock', 'publish_one', 'publish_all', 'cancel_order', 'save_product_sizes')
             ) x, aclexplode(coalesce(x.acl, acldefault(x.k::"char", x.own))) a
            where (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
              and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'EXECUTE')
              and pg_get_userbyid(a.grantor) not in ((select migration_role from params), pg_get_userbyid(x.own)))
              then 'BLOCKER' else 'PASS' end,
         'A non-superuser can only revoke grants it (or the owner) made. 0060''s self-check would refuse to commit (tested); revoke these as their grantor first.'

  -- ── The public schema ──────────────────────
  union all
  select 'S01', 'Owner of schema public, and whether the migration role acts for it',
         (select nspowner::regrole::text || case when pg_has_role((select migration_role from params), nspowner, 'USAGE')
                                                 then ' (migration role is it / a member)' else ' (migration role is NOT a member)' end
            from pg_namespace where nspname = 'public'),
         'pg_database_owner or postgres, and the migration role acts for it',
         case when (select pg_has_role((select migration_role from params), nspowner, 'USAGE') from pg_namespace where nspname = 'public')
              then 'PASS' else 'BLOCKER' end,
         '0060 revokes CREATE on public; without owner rights that revoke cannot take effect and the self-check would stop the migration.'

  union all
  select 'S02', 'Who can CREATE in public today (grants, with grantor)',
         coalesce((select string_agg(format('%s (granted by %s)',
                             case when grantee = 0 then 'PUBLIC' else pg_get_userbyid(grantee) end, pg_get_userbyid(grantor)), ', ')
                     from schema_acl where privilege_type = 'CREATE'), 'nobody listed'),
         'owner only; if PUBLIC, anon or authenticated appear, 0060 removes them',
         case when exists (select 1 from schema_acl where privilege_type = 'CREATE'
                             and (grantee = 0 or grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
                             and not pg_has_role((select migration_role from params), grantor, 'USAGE'))
                then 'BLOCKER'
              when exists (select 1 from schema_acl where privilege_type = 'CREATE' and grantee = 0)
                then 'REVIEW'
              else 'PASS' end,
         'BLOCKER: an API role can CREATE through a grant the migration role cannot revoke. REVIEW: PUBLIC can CREATE; 0060 removes that, so first confirm no other role (listed in S03) relies on it.'

  union all
  select 'S03', 'Non-superuser roles that can CREATE in public today',
         coalesce((select string_agg(rolname, ', ' order by rolname) from pg_roles r
                    where not r.rolsuper and has_schema_privilege(r.oid, 'public', 'CREATE')), 'none'),
         'the migration role, and the schema owner',
         'PASS',
         'Informational. Any role here other than postgres / pg_database_owner that is used by a service (storage, realtime, functions…) loses CREATE if it only had it through PUBLIC — check before approving.'

  -- ── Tables ────────────────────────────────
  union all
  select 'T01', 'Tables 0060 touches are owned by the migration role',
         coalesce((select string_agg(t || ' → ' || coalesce(pg_get_userbyid(c.relowner), 'MISSING'), ', ')
                     from touched_tables left join pg_class c on c.oid = to_regclass('public.' || t)
                    where c.oid is null or pg_get_userbyid(c.relowner) <> (select migration_role from params)),
                  'all owned by ' || (select migration_role from params)),
         'all owned by postgres',
         case when not exists (select 1 from touched_tables left join pg_class c on c.oid = to_regclass('public.' || t)
                                where c.oid is null or pg_get_userbyid(c.relowner) <> (select migration_role from params))
              then 'PASS' else 'BLOCKER' end,
         'ALTER TABLE, CREATE TRIGGER and REVOKE need ownership; 0060 would fail (safely) or be refused by its self-check.'

  union all
  select 'T02', 'Columns 0060 relies on exist',
         coalesce((select string_agg(e.tbl || '.' || e.col, ', ') from expected_columns e
                    where not exists (select 1 from information_schema.columns c
                                       where c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col)),
                  'all present'),
         'all present',
         case when not exists (select 1 from expected_columns e
                                where not exists (select 1 from information_schema.columns c
                                                   where c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col))
              then 'PASS' else 'BLOCKER' end,
         'The schema differs from the one tested.'

  union all
  select 'T03', 'The migration role may reference auth.users (stock_requests.actor_id)',
         case when has_table_privilege((select migration_role from params), 'auth.users', 'REFERENCES') then 'yes' else 'no' end,
         'yes (0038 already did the same for stock_movements)',
         case when has_table_privilege((select migration_role from params), 'auth.users', 'REFERENCES') then 'PASS' else 'BLOCKER' end,
         'CREATE TABLE stock_requests would fail on its foreign key.'

  union all
  select 'T04', '0058''s sale-claim index exists',
         case when to_regclass('public.stock_movements_one_sale_per_line') is null then 'missing' else 'present' end,
         'present',
         case when to_regclass('public.stock_movements_one_sale_per_line') is null then 'BLOCKER' else 'PASS' end,
         'reserve_stock''s idempotency depends on it (0058). 0060 keeps that design and was tested with it.'

  union all
  select 'T05', 'Row-level security is not FORCED on the stock tables',
         coalesce((select string_agg(relname, ', ') from pg_class
                    where relnamespace = 'public'::regnamespace and relforcerowsecurity
                      and relname in ('products', 'product_versions', 'product_sizes', 'stock_movements', 'orders', 'profiles')),
                  'none forced'),
         'none forced',
         case when exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relforcerowsecurity
                             and relname in ('products', 'product_versions', 'product_sizes', 'stock_movements', 'orders', 'profiles'))
              then 'BLOCKER' else 'PASS' end,
         'The SECURITY DEFINER functions rely on the owner bypassing RLS, as every existing one does. FORCE would change that and was not tested.'

  -- ── Triggers ──────────────────────────────
  union all
  select 'R01', 'Expected triggers on the stock tables are present',
         coalesce((select string_agg(e.tbl || '.' || e.tg, ', ') from expected_triggers e
                    where not exists (select 1 from actual_triggers a where a.tbl = e.tbl and a.tg = e.tg)), 'all present'),
         'all present',
         case when not exists (select 1 from expected_triggers e
                                where not exists (select 1 from actual_triggers a where a.tbl = e.tbl and a.tg = e.tg))
              then 'PASS' else 'BLOCKER' end,
         'A trigger the tested behaviour depends on (0014, 0017, 0042, 0051, 0056, 0049) is missing.'

  union all
  select 'R02', 'No unexpected triggers on the stock tables',
         coalesce((select string_agg(a.tbl || '.' || a.tg, ', ') from actual_triggers a
                    where not exists (select 1 from expected_triggers e where e.tbl = a.tbl and e.tg = a.tg)), 'none'),
         'none',
         case when exists (select 1 from actual_triggers a
                            where not exists (select 1 from expected_triggers e where e.tbl = a.tbl and e.tg = a.tg))
              then 'REVIEW' else 'PASS' end,
         'A trigger nobody tested fires inside the stock and publish paths. Read its definition before approving.'

  -- ── Right now ─────────────────────────────
  union all
  select 'X01', 'Drafts of live unsized products whose copied stock has drifted',
         (select count(*)::text from product_versions d
            join product_versions pub on pub.product_id = d.product_id and pub.state = 'published'
           where d.state = 'draft' and d.stock_quantity is distinct from pub.stock_quantity
             and not exists (select 1 from product_sizes s where s.product_id = d.product_id)),
         '0 ideally',
         case when (select count(*) from product_versions d
                     join product_versions pub on pub.product_id = d.product_id and pub.state = 'published'
                    where d.state = 'draft' and d.stock_quantity is distinct from pub.stock_quantity
                      and not exists (select 1 from product_sizes s where s.product_id = d.product_id)) = 0
              then 'PASS' else 'REVIEW' end,
         'Each is a draft that, published BEFORE 0060, would overwrite live stock. Do not publish it before 0060; after 0060 publishing ignores the figure.'
)
select id, what, observed, expected,
       case when observed is null then 'BLOCKER' else verdict end as verdict,
       if_not_pass
  from checks
 order by case case when observed is null then 'BLOCKER' else verdict end
            when 'BLOCKER' then 0 when 'REVIEW' then 1 else 2 end,
          id;

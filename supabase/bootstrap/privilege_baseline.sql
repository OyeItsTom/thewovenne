-- Wovenne privilege baseline — run ONCE on a NEW, EMPTY Supabase project,
-- as postgres, BEFORE migration 0001. Not a migration: it is deliberately
-- outside supabase/migrations so no migration runner picks it up.
--
-- WHY THIS EXISTS. A standard Supabase project ships default privileges that
-- grant anon, authenticated and service_role ALL on every table, sequence and
-- function postgres later creates in public. The Wovenne production project
-- never had those broad grants for anon and authenticated (0004 records the
-- symptom: even service_role had to be granted explicitly). The migrations were
-- written against that restricted project, so they grant API access
-- explicitly where a feature needs it and often restrict a function with
-- `revoke … from public` — which removes nothing on a standard project,
-- because there anon and authenticated hold their own grants, not PUBLIC's.
-- Replayed on a standard project, 0001–0064 therefore produce a database whose
-- anon/authenticated privileges are much broader than production's (the
-- 5 October 2026 audit: 28 tables, 35 functions).
--
-- WHAT IT DOES. Only the default privileges of role postgres in schema public
-- — i.e. what objects created later by the migrations start out with:
--   * anon, authenticated: nothing on new tables, sequences or functions.
--     Every grant they hold must come from a migration, explicitly;
--   * service_role: everything (the trusted server key; 0004 does the same);
--   * no one but the owner may CREATE in public (0060 also enforces this).
-- Functions keep PostgreSQL's built-in EXECUTE-to-PUBLIC default, exactly as
-- production does; migrations restrict a function with `revoke … from public`.
--
-- WHAT IT DOES NOT TOUCH. Supabase-managed schemas (auth, storage, realtime,
-- graphql, vault, extensions), supabase_admin's own default privileges, and any
-- global (non-schema) default privileges. It refuses to run on a database that
-- already has Wovenne tables: on an existing project it would change what
-- future migrations create, which is a separate, reviewed decision.
--
-- Production differs from this baseline in one known, non-API way: its
-- default privileges also give anon and authenticated TRUNCATE, REFERENCES,
-- TRIGGER and MAINTAIN on new tables. None is reachable through the Data API
-- and nothing uses them; this baseline grants none of them (no access by
-- default). See supabase/README.md, "Privilege baseline".

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    raise exception 'BASELINE_REFUSED: role postgres does not exist';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'BASELINE_REFUSED: the Supabase API roles (anon, authenticated, service_role) are missing';
  end if;
  -- Non-superusers may set default privileges only for roles they belong to.
  if not pg_has_role(current_user, 'postgres', 'MEMBER') then
    raise exception 'BASELINE_REFUSED: run this as postgres (current_user is %)', current_user;
  end if;
  if to_regclass('public.products') is not null or to_regclass('public.schema_migrations') is not null then
    raise exception 'BASELINE_REFUSED: public already holds Wovenne tables — this is for a new, empty project only';
  end if;
end $$;

alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

alter default privileges for role postgres in schema public grant all on tables    to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;

grant usage on schema public to anon, authenticated, service_role;
revoke create on schema public from public, anon, authenticated;

-- ── Refuse to leave anything but the intended state ──
-- Schema-level default privileges ADD to global ones and cannot remove them, so
-- a global entry granting the API roles would survive the revokes above. This
-- does not edit global entries (they would reach Supabase's schemas too); it
-- stops, so a person can look.
do $$
declare
  problems text[] := array[]::text[];
begin
  if exists (
    select 1
      from pg_default_acl d, aclexplode(d.defaclacl) a
      join pg_roles g on g.oid = a.grantee
     where d.defaclrole = 'postgres'::regrole
       and (d.defaclnamespace = 'public'::regnamespace or d.defaclnamespace = 0)
       and g.rolname in ('anon', 'authenticated')
  ) then
    problems := problems || 'a default privilege of postgres still grants anon/authenticated something'::text;
  end if;
  if not exists (
    select 1
      from pg_default_acl d, aclexplode(d.defaclacl) a
      join pg_roles g on g.oid = a.grantee
     where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
       and d.defaclobjtype = 'r' and g.rolname = 'service_role' and a.privilege_type = 'INSERT'
  ) then
    problems := problems || 'service_role is not granted new tables by default'::text;
  end if;
  if has_schema_privilege('anon', 'public', 'CREATE') or has_schema_privilege('authenticated', 'public', 'CREATE') then
    problems := problems || 'an API role can CREATE in public'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'BASELINE_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select pg_get_userbyid(d.defaclrole) as for_role,
       coalesce(d.defaclnamespace::regnamespace::text, '(all schemas)') as in_schema,
       case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                            when 'T' then 'types' when 'n' then 'schemas' end as objects,
       d.defaclacl::text as grants
  from pg_default_acl d
 where d.defaclrole = 'postgres'::regrole
 order by 2, 3;

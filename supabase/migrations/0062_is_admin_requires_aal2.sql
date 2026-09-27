-- 0062 — Admin authority requires a two-factor-verified session
--
-- Two-factor authentication is mandatory for staff. Until now it was checked
-- where admin PAGES are served; is_admin(), which every admin RLS policy,
-- admin RPC and admin API route relies on, looked only at profiles.is_admin.
-- The assurance level belongs at that same boundary, so that whatever reaches
-- the database is held to it.
--
-- is_admin() is now: staff (0061's is_staff()) AND the request's token carries
-- aal = 'aal2' — the level Supabase Auth issues once a verified second factor
-- has been presented in that session. Everything that calls is_admin() inherits
-- the requirement with no change of its own.
--
-- Missing or unexpected claims fail closed: no claims, no aal, or any value
-- other than 'aal2' is not an admin. Expiry is enforced before the database is
-- reached (PostgREST rejects an expired token), so it is not re-checked here.
--
-- DEPENDS ON 0061 AND ON THE APPLICATION THAT USES is_staff() FOR ROUTING.
-- Applied before that application is live, a staff member who has only entered
-- a password would be told they are not an admin instead of being sent to the
-- two-factor step. Order: 0061, then the application, then this.
--
-- Service-role callers are unaffected: they bypass RLS, and the one function
-- that admits either an admin or the service role (can_read_analytics, 0025)
-- keeps its service-role branch.
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

do $$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception '0062 requires 0061 (is_staff) to be applied first';
  end if;
end $$;

-- The grants must come through unchanged: RLS policies that call is_admin()
-- are evaluated with the querying role's privileges. Recorded here, compared
-- after the replacement below.
select set_config('wovenne.is_admin_acl_before',
                  coalesce((select proacl::text from pg_proc where oid = 'public.is_admin()'::regprocedure), '<default>'),
                  true);

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $fn$
  select public.is_staff()
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$fn$;

comment on function public.is_admin() is
  'Admin authority: staff (is_staff) AND a two-factor-verified session
   (aal2). Every admin RLS policy, RPC and API route relies on this.';

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
begin
  if coalesce((select proacl::text from pg_proc where oid = 'public.is_admin()'::regprocedure), '<default>')
     is distinct from current_setting('wovenne.is_admin_acl_before') then
    problems := problems || 'is_admin() grants changed';
  end if;
  if not has_function_privilege('authenticated', 'public.is_admin()', 'EXECUTE') then
    problems := problems || 'authenticated can no longer execute is_admin()';
  end if;
  if not (select coalesce(proconfig, '{}') @> array['search_path=public, pg_temp']
            from pg_proc where oid = 'public.is_admin()'::regprocedure) then
    problems := problems || 'is_admin() lacks search_path=public, pg_temp';
  end if;
  if position('aal2' in (select prosrc from pg_proc where oid = 'public.is_admin()'::regprocedure)) = 0 then
    problems := problems || 'is_admin() does not check the assurance level';
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0062_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select
  (select md5(prosrc) from pg_proc where oid = 'public.is_admin()'::regprocedure) as is_admin_body_md5,
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.is_admin()'::regprocedure) as search_path,
  -- Run as the migration role, which has no session: must be false.
  public.is_admin() as migration_session_is_admin_must_be_false;

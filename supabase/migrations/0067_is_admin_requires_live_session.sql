-- 0067 — Admin authority requires the session to still exist
--
-- is_admin() (0062) trusted the access token: staff AND aal = 'aal2' in its
-- claims. An access token is signed for up to an hour and is not recalled when
-- its session ends. Signing out, or the admin idle timeout (which signs out at
-- Supabase — lib/adminSession.ts), deletes the session and kills the refresh
-- token, and the application refuses the old access token from then on. The
-- database did not: a copy of an admin access token taken before the session
-- ended kept full admin RLS against the Data API until the token expired.
--
-- Supabase Auth keeps the authoritative record of live sessions in
-- auth.sessions. Every access token it issues names its row in the session_id
-- claim. Sign-out (local or global) deletes the row; verifying a second factor
-- raises its aal to aal2; removing a factor lowers its sessions back to aal1;
-- deleting the user cascades. not_after is set when sessions are time-boxed.
--
-- is_admin() is now: staff AND an aal2 token AND that token's session still
-- exists, belongs to the same user, is itself at aal2 and is not past
-- not_after. Everything that calls is_admin() — every admin RLS policy (storage
-- included), admin RPC and admin API route — inherits this with no change of
-- its own. is_staff() is untouched: it is identity for routing, not authority.
--
-- Fails closed: no session_id claim, one that is not a uuid, or one that names
-- no live aal2 session of this user is not an admin. Nothing about the session
-- is returned; the function still answers true or false only.
--
-- It reads auth.sessions as its owner (SECURITY DEFINER). On Supabase that is
-- postgres, which holds SELECT on auth.sessions and BYPASSRLS (auth.sessions has
-- RLS on and no policies). If the owner could not see the rows, every admin
-- would be locked out — so the self-check below refuses to commit unless the
-- owner can read them. No API role gains any access to auth.sessions.
--
-- Cost: one primary-key probe of auth.sessions per call, after the profiles
-- probe. The staff test is is_staff()'s expression written out, not a call to
-- it: a SECURITY DEFINER function with SET search_path calling another one
-- re-plans the inner function on every call, and that nested call was most of
-- what 0062's is_admin() cost. Measured on the test harness (10,000 sessions):
-- 0062 about 390 µs a call, this about 135 µs — cheaper with the lookup than
-- without it. The two staff tests must stay identical; the 0067 test suite
-- compares them. Customers stop at the profiles probe.
--
-- Compatible with the application as deployed: every token Supabase Auth
-- issues carries session_id. Apply on its own; no application change needed.
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ──
do $$
declare
  missing text[];
begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception '0067 requires 0061 (is_staff)';
  end if;
  -- Only the definition 0062 wrote is replaced. Anything else means the
  -- function was changed outside the migrations and must be looked at first.
  if md5((select prosrc from pg_proc where oid = 'public.is_admin()'::regprocedure))
       <> '96516dcb5f2713b12f88babedf9094c9' then
    raise exception '0067: is_admin() is not the 0062 definition; refusing to replace it';
  end if;
  if to_regclass('auth.sessions') is null then
    raise exception '0067: auth.sessions does not exist';
  end if;
  select array_agg(col) into missing
    from unnest(array['id', 'user_id', 'aal', 'not_after']) col
   where not exists (select 1 from pg_attribute
                      where attrelid = 'auth.sessions'::regclass and attname = col and not attisdropped);
  if missing is not null then
    raise exception '0067: auth.sessions lacks %', array_to_string(missing, ', ');
  end if;
end $$;

-- The grants must come through unchanged (RLS policies call is_admin() with the
-- querying role's privileges). Recorded here, compared after the replacement.
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
  -- Staff: is_staff()'s own test, written out rather than called (see Cost).
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (
       select 1
         from auth.sessions s
        where s.id = case when pg_input_is_valid(auth.jwt() ->> 'session_id', 'uuid')
                          then (auth.jwt() ->> 'session_id')::uuid end
          and s.user_id = auth.uid()
          and s.aal = 'aal2'
          and (s.not_after is null or s.not_after > now())
     );
$fn$;

comment on function public.is_admin() is
  'Admin authority: staff (is_staff) AND a two-factor-verified token (aal2)
   AND the token''s session (session_id) still live in auth.sessions at aal2.
   Every admin RLS policy, RPC and API route relies on this.';

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
  fn_owner oid := (select proowner from pg_proc where oid = 'public.is_admin()'::regprocedure);
begin
  if coalesce((select proacl::text from pg_proc where oid = 'public.is_admin()'::regprocedure), '<default>')
     is distinct from current_setting('wovenne.is_admin_acl_before') then
    problems := problems || 'is_admin() grants changed'::text;
  end if;
  if not has_function_privilege('authenticated', 'public.is_admin()', 'EXECUTE') then
    problems := problems || 'authenticated can no longer execute is_admin()'::text;
  end if;
  if not (select prosecdef and coalesce(proconfig, '{}') @> array['search_path=public, pg_temp']
            from pg_proc where oid = 'public.is_admin()'::regprocedure) then
    problems := problems || 'is_admin() is not SECURITY DEFINER with search_path=public, pg_temp'::text;
  end if;
  -- The staff test written into is_admin() must be is_staff()'s, exactly.
  if position('coalesce((selectp.is_adminfrompublic.profilespwherep.id=auth.uid()),false)'
              in regexp_replace((select prosrc from pg_proc where oid = 'public.is_staff()'::regprocedure), '\s', '', 'g')) = 0
     or position('coalesce((selectp.is_adminfrompublic.profilespwherep.id=auth.uid()),false)'
              in regexp_replace((select prosrc from pg_proc where oid = 'public.is_admin()'::regprocedure), '\s', '', 'g')) = 0 then
    problems := problems || 'is_admin() and is_staff() no longer share one staff test'::text;
  end if;
  -- The lockout guard: the owner must actually see auth.sessions rows.
  if not has_table_privilege(fn_owner, 'auth.sessions', 'SELECT') then
    problems := problems || 'the owner of is_admin() cannot SELECT auth.sessions'::text;
  end if;
  if (select relrowsecurity from pg_class where oid = 'auth.sessions'::regclass)
     and not (select rolsuper or rolbypassrls from pg_roles where oid = fn_owner)
     and fn_owner <> (select relowner from pg_class where oid = 'auth.sessions'::regclass) then
    problems := problems || 'auth.sessions has RLS and the owner of is_admin() does not bypass it'::text;
  end if;
  -- No API role may read sessions directly.
  if has_table_privilege('anon', 'auth.sessions', 'SELECT')
     or has_table_privilege('authenticated', 'auth.sessions', 'SELECT') then
    problems := problems || 'an API role can read auth.sessions'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0067_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select
  (select md5(prosrc) from pg_proc where oid = 'public.is_admin()'::regprocedure) as is_admin_body_md5,
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.is_admin()'::regprocedure) as search_path,
  (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.is_admin()'::regprocedure) as owner,
  -- Run as the migration role, which has no session: must be false.
  public.is_admin() as migration_session_is_admin_must_be_false;

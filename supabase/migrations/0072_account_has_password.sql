-- 0072 — Whether the signed-in account has a password
--
-- Settings shows a "current password" form to accounts that have a password,
-- and a "Set a password" action to accounts that sign in with Google only. It
-- decided which from the account's identities (an `email` identity meant a
-- password). Proven wrong on production on 17 Oct 2026: a Google-only customer
-- set a password through the emailed recovery link, the password was stored,
-- and Supabase Auth (v2.197.0) added no `email` identity — creating one on a
-- first password is behind an experimental flag that is off for this project.
-- Email-and-password sign-in works for that account (Auth checks the stored
-- password, not the identities), but Settings kept offering to set one.
--
-- The only authoritative signal is the one Auth itself uses:
-- auth.users.encrypted_password is non-empty (models.User.HasPassword). No API
-- role can read that column, and none should. This adds one function that
-- answers true or false about it for the CALLER ONLY:
--
--   * no parameters — there is no way to name another account;
--   * the row is auth.uid()'s, and only while the token's session (session_id)
--     is still live in auth.sessions for that same user, as is_admin() requires
--     since 0067 — a copied token from a signed-out session learns nothing;
--   * returns NULL (unknown) for no live session, no user, or anon; the app
--     treats unknown as "has a password", so a failure never offers a customer
--     who has one a set-up step they do not need;
--   * returns a boolean only — never the hash, identities or metadata;
--   * reads only; it is STABLE and SQL, and writes nothing.
--
-- SECURITY DEFINER because the caller cannot read auth.users. On Supabase the
-- owner is postgres, which holds SELECT on auth.users and BYPASSRLS (auth.users
-- has RLS on). The self-check below refuses to commit otherwise, and refuses if
-- any API role could read the password column directly. EXECUTE: authenticated
-- only (and service_role, through the privilege baseline's defaults); never
-- PUBLIC or anon.
--
-- Changes nothing that exists: no table, policy, grant or function other than
-- the new one. Admin authority (is_admin, 0067) and customer RLS are untouched.
-- Safe to apply ahead of the application; until then Settings falls back to the
-- password form.
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ──
do $$
begin
  if to_regprocedure('public.account_has_password()') is not null then
    raise exception '0072: public.account_has_password() already exists; refusing to replace it';
  end if;
  if to_regclass('auth.users') is null or to_regclass('auth.sessions') is null then
    raise exception '0072: auth.users or auth.sessions does not exist';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'auth.users'::regclass and attname = 'encrypted_password' and not attisdropped) then
    raise exception '0072: auth.users has no encrypted_password column';
  end if;
end $$;

create function public.account_has_password()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $fn$
  -- Zero rows (no live session of this user) is NULL: unknown, not "no".
  select coalesce(u.encrypted_password, '') <> ''
    from auth.users u
   where u.id = auth.uid()
     and exists (
       select 1
         from auth.sessions s
        where s.id = case when pg_input_is_valid(auth.jwt() ->> 'session_id', 'uuid')
                          then (auth.jwt() ->> 'session_id')::uuid end
          and s.user_id = auth.uid()
          and (s.not_after is null or s.not_after > now())
     );
$fn$;

comment on function public.account_has_password() is
  'Whether the CALLER''s account has a stored password, true/false; NULL when
   the token''s session is not live. For the customer Settings page only.
   Never reveals the hash or anything about another account.';

revoke execute on function public.account_has_password() from public, anon;
grant execute on function public.account_has_password() to authenticated;

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
  fn oid := 'public.account_has_password()'::regprocedure;
  fn_owner oid := (select proowner from pg_proc where oid = 'public.account_has_password()'::regprocedure);
begin
  if has_function_privilege('anon', fn, 'EXECUTE') then
    problems := problems || 'anon can execute account_has_password()'::text;
  end if;
  if not has_function_privilege('authenticated', fn, 'EXECUTE') then
    problems := problems || 'authenticated cannot execute account_has_password()'::text;
  end if;
  if not (select prosecdef and provolatile = 's' and coalesce(proconfig, '{}') @> array['search_path=public, pg_temp']
            from pg_proc where oid = fn) then
    problems := problems || 'account_has_password() is not STABLE SECURITY DEFINER with search_path=public, pg_temp'::text;
  end if;
  if (select pronargs from pg_proc where oid = fn) <> 0 then
    problems := problems || 'account_has_password() takes arguments'::text;
  end if;
  -- The owner must actually see the rows, or every answer is NULL.
  if not has_column_privilege(fn_owner, 'auth.users', 'encrypted_password', 'SELECT')
     or not has_table_privilege(fn_owner, 'auth.sessions', 'SELECT') then
    problems := problems || 'the owner of account_has_password() cannot read auth.users / auth.sessions'::text;
  end if;
  if exists (select 1 from pg_class
              where oid in ('auth.users'::regclass, 'auth.sessions'::regclass) and relrowsecurity
                and relowner <> fn_owner)
     and not (select rolsuper or rolbypassrls from pg_roles where oid = fn_owner) then
    problems := problems || 'auth.users / auth.sessions have RLS and the owner does not bypass it'::text;
  end if;
  -- The column itself stays unreadable to every API role.
  if has_column_privilege('anon', 'auth.users', 'encrypted_password', 'SELECT')
     or has_column_privilege('authenticated', 'auth.users', 'encrypted_password', 'SELECT') then
    problems := problems || 'an API role can read auth.users.encrypted_password'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0072_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select
  (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.account_has_password()'::regprocedure) as owner,
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.account_has_password()'::regprocedure) as search_path,
  has_function_privilege('anon', 'public.account_has_password()', 'EXECUTE') as anon_execute_must_be_false,
  has_function_privilege('authenticated', 'public.account_has_password()', 'EXECUTE') as authenticated_execute,
  -- Run as the migration role, which has no session: must be NULL.
  public.account_has_password() as migration_session_must_be_null;

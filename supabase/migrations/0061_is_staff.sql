-- 0061 — Staff identity, separate from admin authority
--
-- Two different questions have been answered by one function, is_admin():
--
--   * "Is this account a member of staff?" — asked BEFORE two-factor
--     authentication is complete: to send a staff member to the two-factor
--     step, to keep staff out of the customer area and the customer login
--     form, and to keep a staff name off a checkout form.
--   * "May this session act as an admin?" — asked by every admin RLS policy,
--     admin RPC and admin API route.
--
-- 0062 makes the second question require a two-factor-verified session. The
-- first must keep working without one, or no member of staff could ever reach
-- the two-factor step. This migration only ADDS the first function; it changes
-- nothing that exists, so it is safe to apply on its own and ahead of the
-- application that uses it.
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local search_path = public, pg_temp;

create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$fn$;

comment on function public.is_staff() is
  'Whether the signed-in account is staff (profiles.is_admin), regardless of
   the session''s authentication level. For routing and for keeping staff out
   of customer flows ONLY — never for authorisation; that is is_admin() (0062).';

revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'is_staff') as is_staff_present,
  (select has_function_privilege('authenticated', 'public.is_staff()', 'EXECUTE')) as authenticated_can_execute,
  (select has_function_privilege('anon', 'public.is_staff()', 'EXECUTE')) as anon_must_be_false,
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.is_staff()'::regprocedure) as search_path;

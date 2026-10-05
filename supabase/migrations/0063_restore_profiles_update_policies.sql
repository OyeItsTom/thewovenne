-- 0063 — Restore the two UPDATE policies on profiles that production lost
--
-- 0002 created four policies on profiles: two SELECT, two UPDATE. Production
-- has only the two SELECT policies. No migration drops the UPDATE ones; the
-- database was "built from hand-pasted fragments" (supabase/README.md) and
-- these two never arrived. Found 5 October 2026 by the Batch 0 signed-in test:
--
--   * saving a delivery address answered "We couldn't save that" — the PATCH
--     matched no row, because with RLS on and no UPDATE policy every UPDATE
--     from a signed-in customer quietly affects nothing;
--   * changing the profile name said "Saved." and changed nothing;
--   * the admin's own UPDATE policy was missing in the same way.
--
-- This recreates both, EXACTLY as 0002 defines them (unchanged since c0d1c22).
-- Nothing is redesigned:
--
--   "Users update own profile"   — a customer, their own row only.
--   "Admins update any profile"  — is_admin(), which since 0062 means staff
--                                  with a two-factor session.
--
-- What a customer may change is still decided by the column grant, not by
-- these policies: authenticated holds UPDATE on (default_address,
-- default_phone, email, full_name, marketing_consent, marketing_consent_at)
-- and NOT on is_admin. The policies would let a customer write anything the
-- grant allows on their own row — so this refuses to run if that grant has
-- ever widened to is_admin, rather than turn a missing policy into
-- self-promotion.
--
-- SAFE AGAINST THE VERIFIED STATE, LOUD AGAINST ANY OTHER. Before changing
-- anything it checks that RLS is on, both SELECT policies are present as 0002
-- wrote them, and no UPDATE policy exists other than one of these two in its
-- intended form. Anything else is an unexpected schema and stops the migration
-- with a named reason; nothing is overwritten to make it fit. Re-running it on
-- a database that already has the intended policies is a no-op in effect.
--
-- No rows are read or written. No other table is touched.
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local lock_timeout = '10s';
set local search_path = public, pg_temp;

-- ── Preconditions ─────────────────────────────
do $$
declare
  problems text[] := array[]::text[];
  p record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass) then
    problems := problems || 'RLS is not enabled on profiles'::text;
  end if;

  if to_regprocedure('public.is_admin()') is null then
    problems := problems || 'public.is_admin() does not exist'::text;
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles'
                  and policyname = 'Users read own profile' and cmd = 'SELECT'
                  and roles = '{authenticated}' and qual = '(id = auth.uid())') then
    problems := problems || 'SELECT policy "Users read own profile" is missing or differs from 0002'::text;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles'
                  and policyname = 'Admins read all profiles' and cmd = 'SELECT'
                  and roles = '{authenticated}' and qual = 'is_admin()') then
    problems := problems || 'SELECT policy "Admins read all profiles" is missing or differs from 0002'::text;
  end if;

  -- An existing UPDATE (or ALL) policy is acceptable only if it is one of the
  -- two this migration restores, already in its intended form.
  for p in
    select policyname, cmd, roles::text as roles, permissive, qual, with_check
      from pg_policies
     where schemaname = 'public' and tablename = 'profiles' and cmd in ('UPDATE', 'ALL')
  loop
    if not (
      p.cmd = 'UPDATE' and p.roles = '{authenticated}' and p.permissive = 'PERMISSIVE' and (
        (p.policyname = 'Users update own profile'
           and p.qual = '(id = auth.uid())' and p.with_check = '(id = auth.uid())')
        or
        (p.policyname = 'Admins update any profile'
           and p.qual = 'is_admin()' and p.with_check = 'is_admin()')
      )
    ) then
      problems := problems || format('unexpected %s policy on profiles: %s', p.cmd, p.policyname)::text;
    end if;
  end loop;

  -- The policies grant row access; the column grant is what keeps is_admin out
  -- of a customer's reach. Restoring them on top of a wider grant would open
  -- self-promotion, so that is refused outright.
  if has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'UPDATE') then
    problems := problems || 'authenticated can UPDATE profiles.is_admin — restoring the policies would allow self-promotion'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0063_PRECONDITION_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── The two policies, exactly as 0002 defines them ──
drop policy if exists "Users update own profile" on profiles;
create policy "Users update own profile"
  on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Admins update any profile" on profiles;
create policy "Admins update any profile"
  on profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
begin
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'profiles') <> 4 then
    problems := problems || 'profiles does not have exactly four policies'::text;
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'profiles'
        and cmd = 'UPDATE' and roles = '{authenticated}' and permissive = 'PERMISSIVE'
        and ((policyname = 'Users update own profile' and qual = '(id = auth.uid())' and with_check = '(id = auth.uid())')
          or (policyname = 'Admins update any profile' and qual = 'is_admin()' and with_check = 'is_admin()'))) <> 2 then
    problems := problems || 'the two UPDATE policies are not in their intended form'::text;
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'UPDATE') then
    problems := problems || 'authenticated can UPDATE profiles.is_admin'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0063_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select policyname, cmd, roles::text as roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename = 'profiles'
 order by cmd, policyname;

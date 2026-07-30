-- 0002 — Admin identity
-- profiles + is_admin(). Every admin policy in 0003 calls is_admin(), so this
-- must run before it. Nothing here promotes anyone — see 0008.

-- ── Admin identity ──────────────────────────
-- Every auth user gets a profile row; only is_admin = true may manage the
-- catalogue. Before this existed, ANY authenticated Supabase user was treated
-- as an admin. That becomes acute the moment customer sign-up ships, because
-- customers authenticate against this same project and would inherit full
-- write access to products, categories, content and orders.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz default now()
);

-- SECURITY DEFINER so table policies can call this without recursing through
-- the RLS on profiles itself (a policy on profiles that queried profiles would
-- deadlock into infinite recursion).
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Gives a new signup a profile row (defaulting to is_admin = false).
--
-- Deliberately NOT wired to a trigger. Creating one on auth.users requires
-- ownership of that table, which this project's SQL-editor role may not have —
-- and a failure there aborts the rest of this file, silently skipping every
-- grant below. If you confirm you have the privilege, wire it with:
--
--   create trigger on_auth_user_created
--     after insert on auth.users
--     for each row execute function public.handle_new_user();
--
-- Until then, profile creation belongs in application code at signup, which is
-- only needed once customer accounts ship.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Backfill anyone who signed up before this table existed. Nobody is promoted
-- automatically — see the note at the bottom of this file for how to grant
-- yourself admin, which you MUST do or you will lock yourself out of /admin.
--
-- Guarded: reading auth.users needs privileges this role may lack, and an
-- unguarded failure here would abort every statement below it.
do $$
begin
  insert into public.profiles (id, email)
  select u.id, u.email from auth.users u
  on conflict (id) do nothing;
exception when insufficient_privilege or undefined_table then
  raise notice 'Skipped auth.users backfill (%). Insert your admin profile row by hand.', sqlerrm;
end $$;

alter table profiles enable row level security;

-- Profiles: you can see and edit your own; admins can see and edit anyone's.
drop policy if exists "Users read own profile" on profiles;
create policy "Users read own profile"
  on profiles for select to authenticated using (id = auth.uid());
drop policy if exists "Admins read all profiles" on profiles;
create policy "Admins read all profiles"
  on profiles for select to authenticated using (public.is_admin());
drop policy if exists "Users update own profile" on profiles;
create policy "Users update own profile"
  on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "Admins update any profile" on profiles;
create policy "Admins update any profile"
  on profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

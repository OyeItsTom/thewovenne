-- 0023 — Customer accounts
--
-- Customers share the admin's Supabase Auth project rather than getting their
-- own. Two auth systems would mean two session models and two places to get RLS
-- wrong, and the isolation that matters is already enforced: is_admin defaults
-- false, every admin policy calls is_admin(), and 0004 grants UPDATE on only
-- (email, full_name) so an authenticated user cannot set their own is_admin.
-- That column grant — not the RLS policy — is what makes sharing safe.
--
-- What was missing: nothing created a profile row on signup. 0002 wrote
-- handle_new_user() but deliberately left it unwired, because there were no
-- signups to wire it for.

-- ── A profile for every new account ───────────
-- SECURITY DEFINER so it can write a table the new user has no INSERT grant on.
-- is_admin is set explicitly to false rather than left to the column default:
-- the default is already false, but stating it here means a future change to
-- that default cannot silently start minting admins from the signup path.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id, email, full_name, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Existing accounts predate the trigger; give them profiles too.
insert into public.profiles (id, email, full_name, is_admin)
select u.id, u.email, '', false
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- ── A customer can see their own orders ───────
-- Matched on the VERIFIED email of the signed-in user, not on a value supplied
-- by the client. auth.email() comes from the JWT, so it cannot be spoofed by
-- asking for someone else's orders.
--
-- This is also what makes guest checkout and accounts fit together: an order
-- placed as a guest appears in the account later, if the same address is used
-- to sign up, without linking anything at checkout time.
drop policy if exists "Customers read own orders" on orders;
create policy "Customers read own orders"
  on orders for select to authenticated
  using (lower(customer_email) = lower(auth.email()));

-- ── Wishlists ─────────────────────────────────
create table if not exists wishlists (
  user_id    uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

alter table wishlists enable row level security;

-- Own rows only, on every verb. `using` governs which rows are visible to
-- update/delete; `with check` governs what may be written — both are needed, or
-- a customer could insert a row belonging to someone else.
do $$ begin
  create policy "Customers manage own wishlist"
    on wishlists for all to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

grant select, insert, delete on wishlists to authenticated;
grant all on wishlists to service_role;

create index if not exists wishlists_user_idx on wishlists (user_id);

-- ── Deliberately NOT changed ──────────────────
-- No new access to product_versions, category_versions, site_content,
-- site_page_versions, admin_audit_log, chat_usage or product_sizes. A customer
-- account grants exactly two things: their own profile row, and rows keyed to
-- their own auth.uid() or verified email. Everything admin stays is_admin().

-- ── Verify ────────────────────────────────────
-- No auth-gated function is called here: the SQL editor runs as postgres with
-- no auth.uid(), so anything checking is_admin() or auth.email() would raise and
-- roll the whole migration back.
select
  (select count(*) from pg_trigger where tgname = 'on_auth_user_created') as signup_trigger,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'wishlists') as wishlists_table,
  (select count(*) from auth.users) as auth_users,
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.profiles where is_admin) as admins;

-- 0035 — A saved delivery address, at last
--
-- Until now the shop held no customer address book. Addresses existed only on
-- orders, captured at checkout, which is why the account sidebar had no
-- Addresses entry: a menu item leading to an empty page is worse than none.
--
-- ONE ADDRESS, NOT A BOOK. A list of saved addresses needs a default, a picker
-- at checkout, an editor, and a rule for what happens when the default is
-- deleted mid-order. One "where your orders usually go" answers the actual
-- need — save me typing it again — at a fraction of the surface area. A second
-- address can be typed at checkout any time, because the checkout fields stay
-- editable and always will.
--
-- It is a SUGGESTION, never an authority. The address on an order is the one
-- typed at checkout and copied onto that order, so editing this later can
-- never change where a parcel already in flight is going.

alter table profiles
  add column if not exists default_address jsonb,
  add column if not exists default_phone text;

comment on column profiles.default_address is
  'Where this customer usually wants orders sent. A starting point for the
   checkout form, never the authority on an existing order — orders carry
   their own copy of the address they were placed with.';

-- The customer owns these two, like marketing_consent (0026). Column-level
-- grants rather than a blanket update: this list is the reason a customer
-- cannot make themselves an admin by writing to their own profile row.
grant update (full_name, marketing_consent, default_address, default_phone)
  on profiles to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name in ('default_address', 'default_phone')) as columns_added,
  (select count(*) from information_schema.column_privileges
    where table_name = 'profiles' and grantee = 'authenticated'
      and privilege_type = 'UPDATE'
      and column_name in ('default_address', 'default_phone')) as grants_present,
  (select count(*) from information_schema.column_privileges
    where table_name = 'profiles' and grantee = 'authenticated'
      and privilege_type = 'UPDATE' and column_name = 'is_admin') as must_be_zero;

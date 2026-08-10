-- 0056 — A sized product's total stock is the sum of its sizes, always
--
-- Product 001 held stock_quantity = 2 while its sizes held 4 and 9. Neither
-- number was wrong when it was typed; they were simply two independent facts
-- about one thing, kept in step by hand, and hands do not scale.
--
-- WHAT ALREADY WORKED. take_stock (0038) has always done the right thing: for a
-- product with sizes it decrements product_sizes and never touches the version
-- column at all. So the column was not driving the checkout — it was vestigial,
-- holding whatever the product form last wrote, and every OTHER reader believed
-- it: the card's "sold out" badge, the low-stock line, Ask Wovenne's
-- check_availability, the CSV export, the admin table. 001 showed as nearly gone
-- on a listing while holding thirteen units.
--
-- WHY A MIGRATION RATHER THAN APPLICATION LOGIC. Deriving the sum at read time
-- means every one of those readers has to remember to join product_sizes, and
-- the one that forgets is silently wrong — which is exactly the bug being fixed,
-- moved somewhere harder to see. It also leaves the stored column holding a
-- number that disagrees with reality, which anyone reading the table directly
-- (or exporting it) would believe. Two triggers make the column true for every
-- reader, present and future, with no application change at all.
--
-- TWO TRIGGERS, BECAUSE NEITHER IS ENOUGH ALONE:
--
--   * BEFORE on product_versions catches anything WRITING a version — the
--     product form, the CSV import, a new draft forked from published. Whatever
--     number arrives, if the product has sizes it is replaced by the sum.
--   * AFTER on product_sizes catches anything CHANGING A SIZE — a sale, a
--     restock, an admin editing quantities. The versions are brought back in
--     line.
--
-- ARCHIVED VERSIONS ARE NEVER TOUCHED. They are the record of what was published
-- at the time, and rewriting their stock would be falsifying history to make a
-- number tidy. 001 has five of them, all reading 2; they stay reading 2. Only
-- draft and published are derived.
--
-- A PRODUCT WITH NO SIZES IS COMPLETELY UNAFFECTED. Sarees are sold as single
-- pieces and their stock_quantity stays exactly what somebody types. Every rule
-- below is conditional on sizes existing.
--
-- ONE CONSEQUENCE WORTH KNOWING: product_versions carries an audit trigger, so a
-- sale of a sized product now writes one audit row for the version as well as
-- the stock_movements row it always wrote. That is a true record of a real
-- change, but it is new noise in a log meant for admin actions, and it is better
-- to say so here than to have somebody find it.

-- ── The sum, in one place ──────────────────────
-- Returns NULL when a product has no sizes, which is what every rule below tests
-- to decide whether it applies. Null and 0 are different answers: 0 means sized
-- and sold out, null means this product does not use sizes at all.
create or replace function public.product_size_total(p_product_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select case when count(*) = 0 then null else coalesce(sum(stock_quantity), 0)::integer end
    from product_sizes
   where product_id = p_product_id;
$fn$;

-- ── Anything writing a version ─────────────────
create or replace function public.derive_version_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  total integer;
begin
  -- Only the two live states. An update that ARCHIVES a row must leave its
  -- stock as the historical record of what was on the shelf, so this deliberately
  -- does not fire for it.
  if new.state not in ('draft', 'published') then
    return new;
  end if;

  total := public.product_size_total(new.product_id);
  if total is not null then
    new.stock_quantity := total;
  end if;

  return new;
end;
$fn$;

drop trigger if exists derive_stock_from_sizes on product_versions;
create trigger derive_stock_from_sizes
  before insert or update on product_versions
  for each row execute function public.derive_version_stock();

-- ── Anything changing a size ───────────────────
create or replace function public.resync_versions_from_sizes()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  pid   uuid := coalesce(new.product_id, old.product_id);
  total integer;
begin
  total := public.product_size_total(pid);

  -- Every size deleted means the product is no longer sized. Its column is left
  -- exactly as it is rather than zeroed: an admin removing sizes to sell
  -- something as a single piece would otherwise find it silently sold out.
  if total is null then
    return coalesce(new, old);
  end if;

  update product_versions
     set stock_quantity = total
   where product_id = pid
     and state in ('draft', 'published')
     -- No-op writes would fire the audit trigger for nothing.
     and stock_quantity is distinct from total;

  return coalesce(new, old);
end;
$fn$;

drop trigger if exists resync_stock_from_sizes on product_sizes;
create trigger resync_stock_from_sizes
  after insert or update or delete on product_sizes
  for each row execute function public.resync_versions_from_sizes();

-- ── Put the existing rows right ────────────────
-- This is what corrects 001 from 2 to 13. Draft and published only, for the
-- reason above.
update product_versions pv
   set stock_quantity = public.product_size_total(pv.product_id)
 where pv.state in ('draft', 'published')
   and public.product_size_total(pv.product_id) is not null
   and pv.stock_quantity is distinct from public.product_size_total(pv.product_id);

comment on function public.product_size_total(uuid) is
  'Total stock across a product''s sizes, or NULL when it has none. The single
   definition of "how many are there" for a sized product — see 0056.';

-- ── Verify ────────────────────────────────────
select
  (select count(*) from pg_trigger
    where tgrelid = 'product_versions'::regclass and tgname = 'derive_stock_from_sizes') as write_guard,
  (select count(*) from pg_trigger
    where tgrelid = 'product_sizes'::regclass and tgname = 'resync_stock_from_sizes') as size_guard,
  -- Should be zero: no live version of a sized product disagreeing with its sizes.
  (select count(*) from product_versions pv
    where pv.state in ('draft', 'published')
      and public.product_size_total(pv.product_id) is not null
      and pv.stock_quantity is distinct from public.product_size_total(pv.product_id)) as still_disagreeing,
  -- 001, named because it is the row that prompted this.
  (select pv.stock_quantity from product_versions pv
     join products p on p.id = pv.product_id
    where p.slug = '001' and pv.state = 'published') as product_001_published,
  -- Its archived history, untouched.
  (select count(distinct pv.stock_quantity) from product_versions pv
     join products p on p.id = pv.product_id
    where p.slug = '001' and pv.state = 'archived') as archived_values_kept;

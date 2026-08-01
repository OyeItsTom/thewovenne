-- 0016 — Seasonal campaigns
--
-- Three pieces, all quiet by default:
--   1. A homepage "seasonal edit" section below the hero, hidden unless enabled.
--   2. Collection membership, so products can be grouped as an "Onam Edit".
--   3. Optional per-product discounts with a start/end window.
--
-- Campaign fields live on product_versions rather than in a side table, so they
-- inherit draft/publish for free: marking a product into a collection or setting
-- a discount is a draft change until Publish, same as editing its price.
--
-- Requires 0011 (versioning) and 0012 (draft helpers).

-- ── Campaign fields on the product version ────
alter table product_versions
  add column if not exists collection text,
  add column if not exists discount_type text,
  add column if not exists discount_value numeric(10,2),
  add column if not exists discount_starts_at timestamptz,
  add column if not exists discount_ends_at timestamptz;

do $$ begin
  alter table product_versions
    add constraint product_versions_discount_type_check
    check (discount_type is null or discount_type in ('percent', 'flat'));
exception when duplicate_object then null; end $$;

-- A discount is either fully specified or absent. Half a discount (a type with
-- no value) would otherwise silently price at full or at zero.
do $$ begin
  alter table product_versions
    add constraint product_versions_discount_pair_check
    check (
      (discount_type is null and discount_value is null) or
      (discount_type is not null and discount_value is not null and discount_value > 0)
    );
exception when duplicate_object then null; end $$;

-- Percentages above 100 would produce a negative price.
do $$ begin
  alter table product_versions
    add constraint product_versions_discount_percent_check
    check (discount_type is distinct from 'percent' or discount_value <= 100);
exception when duplicate_object then null; end $$;

create index if not exists product_versions_collection_idx
  on product_versions (collection) where state = 'published';

-- ── The pricing authority ─────────────────────
-- One definition of what a product costs, used by the checkout. Display code
-- mirrors this rule, but this is the version that decides what a customer is
-- charged, so a stale page or a doctored request cannot set its own price.
--
-- Rounded to whole rupees to match formatINR, and floored at ₹1 — Razorpay
-- rejects a zero amount, and a free order should be a deliberate act, not the
-- result of a mistyped discount.
create or replace function public.effective_price(
  p_price numeric,
  p_type text,
  p_value numeric,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns numeric
language sql
immutable
as $$
  select case
    when p_type is null or p_value is null then round(p_price)
    when p_starts_at is not null and now() < p_starts_at then round(p_price)
    when p_ends_at   is not null and now() >= p_ends_at  then round(p_price)
    when p_type = 'percent' then greatest(round(p_price * (1 - p_value / 100)), 1)
    when p_type = 'flat'    then greatest(round(p_price - p_value), 1)
    else round(p_price)
  end;
$$;

-- What the checkout charges. Takes product IDENTITY ids (what the cart holds)
-- and returns the published price, discount applied. Unknown or unpublished
-- ids simply return no row, so the caller can reject them.
create or replace function public.checkout_prices(p_ids uuid[])
returns table (product_id uuid, name text, price_inr numeric, in_stock boolean)
language sql
security definer
stable
set search_path = public
as $$
  select
    pv.product_id,
    pv.name,
    public.effective_price(pv.price_inr, pv.discount_type, pv.discount_value,
                           pv.discount_starts_at, pv.discount_ends_at),
    pv.stock_quantity > 0
  from product_versions pv
  where pv.state = 'published'
    and pv.is_active
    and pv.product_id = any(p_ids);
$$;

revoke execute on function public.checkout_prices(uuid[]) from public;
grant execute on function public.checkout_prices(uuid[]) to service_role;

-- ── Carry the new columns through the draft fork ──
-- ensure_product_draft copies an explicit column list. Without adding these,
-- editing any product would silently reset its campaign fields to null — the
-- same class of bug that stranded an earlier price edit.
create or replace function public.ensure_product_draft(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_id uuid;
  source   product_versions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit products';
  end if;

  select id into draft_id
    from product_versions
   where product_id = p_product_id and state = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;

  select * into source
    from product_versions
   where product_id = p_product_id and state = 'published';
  if not found then
    raise exception 'Product % has no published version to fork', p_product_id;
  end if;

  insert into product_versions
    (product_id, state, version, name, slug, description, price_inr, category_id,
     fabric, colour, stock_quantity, image_url, is_active, created_by,
     collection, discount_type, discount_value, discount_starts_at, discount_ends_at)
  values
    (source.product_id, 'draft', source.version + 1, source.name, source.slug,
     source.description, source.price_inr, source.category_id, source.fabric,
     source.colour, source.stock_quantity, source.image_url, source.is_active,
     auth.uid(),
     source.collection, source.discount_type, source.discount_value,
     source.discount_starts_at, source.discount_ends_at)
  returning id into draft_id;

  -- The gallery is part of the version, so the fork has to carry it.
  insert into product_images (product_version_id, product_id, url, sort_order)
  select draft_id, source.product_id, url, sort_order
    from product_images
   where product_version_id = source.id;

  return draft_id;
end;
$$;

revoke execute on function public.ensure_product_draft(uuid) from public;
grant execute on function public.ensure_product_draft(uuid) to authenticated;

-- ── The homepage seasonal section ─────────────
-- A site_content key, so it inherits 0010's draft/publish and the existing
-- content editor. enabled=false keeps it off the homepage entirely, which is
-- the state it ships in.
insert into site_content (key, value, draft_value)
select
  'seasonal_edit',
  '{"enabled": false, "eyebrow": "", "heading": "", "body": "",
    "image_url": "", "link_label": "", "link_href": ""}'::jsonb,
  '{"enabled": false, "eyebrow": "", "heading": "", "body": "",
    "image_url": "", "link_label": "", "link_href": ""}'::jsonb
where not exists (select 1 from site_content where key = 'seasonal_edit');

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_name = 'product_versions'
      and column_name in ('collection', 'discount_type', 'discount_value',
                          'discount_starts_at', 'discount_ends_at')) as new_columns,
  (select count(*) from site_content where key = 'seasonal_edit') as seasonal_key,
  public.effective_price(6000, 'percent', 10, null, null) as should_be_5400,
  public.effective_price(6000, 'flat', 500, null, null) as should_be_5500,
  public.effective_price(6000, 'percent', 10, now() + interval '1 day', null) as should_be_6000_not_started,
  public.effective_price(6000, 'percent', 10, null, now() - interval '1 day') as should_be_6000_expired;

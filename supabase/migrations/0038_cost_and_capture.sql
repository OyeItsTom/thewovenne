-- 0038 — The facts that cannot be reconstructed later
--
-- Everything here captures something AT THE MOMENT IT HAPPENS. None of it can
-- be backfilled: what a piece cost when it sold, what the courier actually
-- charged, what the payment gateway took, and when stock moved and why. A P&L
-- built later can read data it already has; it cannot invent data nobody
-- recorded. That is the whole reason this lands before the reporting work
-- rather than after it.
--
-- WHAT WAS CHARGED IS NOT WHAT WAS PAID. orders.shipping_cost_inr is the
-- delivery fee the CUSTOMER was charged at checkout. It says nothing about what
-- the courier billed, and using it as a cost would overstate gross profit on
-- every order with free delivery. courier_actual_cost_inr is the other number,
-- and it is deliberately separate and nullable — it arrives later, from a
-- Shiprocket export, long after the order.
--
-- COST IS SNAPSHOTTED, NOT LOOKED UP. Each order line carries the cost of that
-- piece as at the moment it sold. Reading a live products.cost_price_inr at
-- report time would silently rewrite last quarter's margin every time a weaver
-- renegotiates. orders.cogs_inr denormalises the total of those lines so a P&L
-- over a date range is one sum rather than a walk through JSON.
--
-- THE CARRY-THROUGH TRAP, and the thing most likely to go wrong here.
-- product_versions columns are copied by an EXPLICIT LIST in four places:
-- ensure_product_draft (0016), create_product_draft (0022), publish_one (0018)
-- and publish_all (0013). A column added without touching all four is silently
-- dropped — 0016 records that exact bug stranding a price edit.
--
-- The two draft functions are rewritten below. The two PUBLISH paths are not:
-- they are large, they contain much more than products, and restating them to
-- widen one UPDATE risks dropping an unrelated branch. More importantly, a
-- fifth column list would not fix the problem — it would add another place to
-- forget. The columns they omit are carried by a trigger instead, so the next
-- column added needs one change rather than four.
--
-- That trap has ALREADY fired once: see the trigger below for what 0037 lost.

-- ══ Products: SKU and cost ════════════════════

alter table products
  add column if not exists sku            text,
  add column if not exists cost_price_inr numeric(10,2) check (cost_price_inr is null or cost_price_inr >= 0);

alter table product_versions
  add column if not exists sku            text,
  add column if not exists cost_price_inr numeric(10,2) check (cost_price_inr is null or cost_price_inr >= 0);

comment on column products.cost_price_inr is
  'What this piece costs US, today. The CURRENT cost, used to seed an order
   line at checkout. Never read it for historical reporting — the order carries
   its own snapshot, which is the only figure that stays true.';

comment on column products.sku is
  'Stable identifier for spreadsheets and bulk import. Derived from the slug at
   creation and then INDEPENDENT of it: renaming a piece must not silently
   repoint an import that matches on SKU.';

-- Derived from the slug, uppercased, non-alphanumerics collapsed to a hyphen.
-- A function rather than inline so the import path and the draft creator agree
-- on what a generated SKU looks like.
create or replace function public.sku_from_slug(p_slug text)
returns text
language sql
immutable
as $$
  select nullif(upper(regexp_replace(coalesce(p_slug, ''), '[^a-zA-Z0-9]+', '-', 'g')), '');
$$;

-- Backfill. Existing products have slugs; nothing else has ever had a SKU.
update products
   set sku = public.sku_from_slug(slug)
 where sku is null and slug is not null and slug <> '';

update product_versions pv
   set sku = public.sku_from_slug(pv.slug)
 where pv.sku is null and pv.slug is not null and pv.slug <> '';

-- Unique where present, so an import matching on SKU cannot hit two rows.
-- Partial, because a placeholder draft has no SKU yet and several may exist.
create unique index if not exists products_sku_unique
  on products (sku) where sku is not null;

-- ══ Orders: what it cost us ═══════════════════

alter table orders
  -- Sum of (cost snapshot x quantity) across the lines, at payment.
  add column if not exists cogs_inr                numeric(10,2) not null default 0,
  -- What the courier actually billed. Null until a Shiprocket export says.
  add column if not exists courier_actual_cost_inr numeric(10,2),
  -- What Razorpay took, read from their API at verification. Their fee and the
  -- GST on it are separate figures on the settlement, so they are separate here
  -- — netting them together loses the input credit once GST registration
  -- happens, and cannot be unpicked afterwards.
  add column if not exists gateway_fee_inr         numeric(10,2),
  add column if not exists gateway_tax_inr         numeric(10,2);

comment on column orders.cogs_inr is
  'Cost of goods for this order, snapshotted at payment. Independent of any
   later change to products.cost_price_inr — that is the point of it.';

comment on column orders.courier_actual_cost_inr is
  'What the courier billed us. NOT shipping_cost_inr, which is what the
   customer was charged and is frequently zero.';

create index if not exists orders_paid_at_idx
  on orders (created_at desc) where payment_status = 'paid';

-- ══ Stock movements ═══════════════════════════
--
-- Stock lives in product_sizes, and product_sizes has NO audit trigger — the
-- triggers in 0009 cover products, categories, site_content and journal_posts,
-- none of which is where a sale actually decrements anything. So there has
-- never been any record of stock moving, only of its current value.
--
-- A dedicated table rather than another audit trigger: a movement has a REASON
-- (sale, return, manual correction) that a generic row-diff cannot infer, and
-- the reason is the entire value of the log when counts disagree with reality.
create table if not exists stock_movements (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid references products(id) on delete set null,
  -- Text, not a size FK: the label is what was sold, and a size row can be
  -- renamed or removed afterwards without rewriting history.
  size_label   text,
  -- Negative takes stock out, positive puts it back.
  delta        integer not null check (delta <> 0),
  reason       text not null check (reason in ('sale', 'return', 'cancellation', 'correction', 'restock')),
  order_id     uuid references orders(id) on delete set null,
  note         text,
  actor_id     uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists stock_movements_product_idx on stock_movements (product_id, created_at desc);
create index if not exists stock_movements_order_idx on stock_movements (order_id);
create index if not exists stock_movements_created_idx on stock_movements (created_at desc);

alter table stock_movements enable row level security;

drop policy if exists "Admins read stock movements" on stock_movements;
create policy "Admins read stock movements"
  on stock_movements for select to authenticated using (public.is_admin());

grant select on stock_movements to authenticated;

-- ══ reserve_stock / release_stock: now they record ══
-- Same guarded UPDATE as 0021 — the concurrency behaviour is unchanged and
-- must stay unchanged. The only addition is the movement row, written after a
-- decrement that actually matched, so a refused reservation logs nothing.

-- DROP FIRST, and this is not tidiness. `create or replace` with a new
-- parameter creates an OVERLOAD rather than replacing anything, so the old
-- one-argument reserve_stock(jsonb) would survive alongside this one — and a
-- call passing only p_items then matches both, which Postgres refuses as
-- "function is not unique". Checkout would break on the next payment.
drop function if exists public.reserve_stock(jsonb);

create or replace function public.reserve_stock(p_items jsonb, p_order_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  item      jsonb;
  p_id      uuid;
  p_label   text;
  p_qty     integer;
  has_sizes boolean;
  affected  integer;
  taken     integer := 0;
begin
  for item in select * from jsonb_array_elements(p_items) loop
    p_id    := (item ->> 'id')::uuid;
    p_label := item ->> 'size';
    p_qty   := coalesce((item ->> 'quantity')::integer, 0);

    if p_qty <= 0 then
      raise exception 'Invalid quantity for product %', p_id;
    end if;

    select exists (select 1 from product_sizes where product_id = p_id)
      into has_sizes;

    if has_sizes then
      update product_sizes
         set stock_quantity = stock_quantity - p_qty
       where product_id = p_id
         and label = p_label
         and stock_quantity >= p_qty;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'SOLD_OUT:%:%', p_id, coalesce(p_label, '');
      end if;
    else
      update product_versions
         set stock_quantity = stock_quantity - p_qty
       where product_id = p_id
         and state = 'published'
         and stock_quantity >= p_qty;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'SOLD_OUT:%:', p_id;
      end if;
    end if;

    insert into stock_movements (product_id, size_label, delta, reason, order_id)
    values (p_id, p_label, -p_qty, 'sale', p_order_id);

    taken := taken + p_qty;
  end loop;

  return jsonb_build_object('reserved', taken);
end;
$fn$;

revoke execute on function public.reserve_stock(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.reserve_stock(jsonb, uuid) to service_role;

-- p_reason is explicit: a cancellation before dispatch and a return after
-- delivery both put stock back, and a log that cannot tell them apart is a log
-- nobody trusts when the counts drift.
-- Same overload trap as reserve_stock above.
drop function if exists public.release_stock(jsonb);

create or replace function public.release_stock(
  p_items jsonb,
  p_order_id uuid default null,
  p_reason text default 'return'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  item      jsonb;
  p_id      uuid;
  p_label   text;
  p_qty     integer;
  has_sizes boolean;
  given     integer := 0;
begin
  if p_reason not in ('return', 'cancellation', 'correction', 'restock') then
    raise exception 'Unknown stock movement reason: %', p_reason;
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    p_id    := (item ->> 'id')::uuid;
    p_label := item ->> 'size';
    p_qty   := coalesce((item ->> 'quantity')::integer, 0);

    if p_qty <= 0 then
      raise exception 'Invalid quantity for product %', p_id;
    end if;

    select exists (select 1 from product_sizes where product_id = p_id)
      into has_sizes;

    if has_sizes then
      update product_sizes
         set stock_quantity = stock_quantity + p_qty
       where product_id = p_id and label = p_label;
    else
      update product_versions
         set stock_quantity = stock_quantity + p_qty
       where product_id = p_id and state = 'published';
    end if;

    insert into stock_movements (product_id, size_label, delta, reason, order_id)
    values (p_id, p_label, p_qty, p_reason, p_order_id);

    given := given + p_qty;
  end loop;

  return jsonb_build_object('released', given);
end;
$fn$;

revoke execute on function public.release_stock(jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.release_stock(jsonb, uuid, text) to service_role;

-- ══ checkout_prices: hand back the cost too ═══
-- So priceCart can snapshot it onto the order line. Cost never reaches the
-- browser: this is service_role only and the route puts it on the order row.
-- Postgres refuses to change a function's return type in place — "cannot change
-- return type of existing function" — and this adds two columns to the returned
-- table, so it must be dropped rather than replaced.
drop function if exists public.checkout_prices(uuid[]);

create or replace function public.checkout_prices(p_ids uuid[])
returns table (
  product_id uuid,
  name text,
  price_inr numeric,
  cost_price_inr numeric,
  sku text,
  in_stock boolean
)
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
    pv.cost_price_inr,
    pv.sku,
    pv.stock_quantity > 0
  from product_versions pv
  where pv.state = 'published'
    and pv.is_active
    and pv.product_id = any(p_ids);
$$;

revoke execute on function public.checkout_prices(uuid[]) from public;
grant execute on function public.checkout_prices(uuid[]) to service_role;

-- ══ THE CARRY-THROUGH ═════════════════════════
-- All four places that enumerate product_versions columns. Miss one and the
-- new fields vanish on the next edit or publish.

-- 1. ensure_product_draft — forks the published row into a draft.
create or replace function public.ensure_product_draft(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  draft_id uuid;
  source   product_versions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit products';
  end if;

  select id into draft_id from product_versions
   where product_id = p_product_id and state = 'draft';
  if draft_id is not null then
    return draft_id;
  end if;

  select * into source from product_versions
   where product_id = p_product_id and state = 'published';
  if not found then
    raise exception 'No published version for that product';
  end if;

  insert into product_versions
    (product_id, state, version, name, slug, description, price_inr, category_id,
     fabric, colour, stock_quantity, image_url, is_active, created_by,
     collection, discount_type, discount_value, discount_starts_at, discount_ends_at,
     hsn_code, sku, cost_price_inr)
  values
    (source.product_id, 'draft', source.version + 1, source.name, source.slug,
     source.description, source.price_inr, source.category_id, source.fabric,
     source.colour, source.stock_quantity, source.image_url, source.is_active,
     auth.uid(),
     source.collection, source.discount_type, source.discount_value,
     source.discount_starts_at, source.discount_ends_at,
     source.hsn_code, source.sku, source.cost_price_inr)
  returning id into draft_id;

  insert into product_images (product_version_id, product_id, url, sort_order)
  select draft_id, source.product_id, url, sort_order
    from product_images
   where product_version_id = source.id;

  return draft_id;
end;
$fn$;

revoke execute on function public.ensure_product_draft(uuid) from public;
grant execute on function public.ensure_product_draft(uuid) to authenticated, service_role;

-- 2. create_product_draft — a brand-new product. Keeps 0022's placeholders and
--    the random slug; the SKU is left null deliberately, because it is derived
--    from the real slug the admin types, not from a placeholder.
create or replace function public.create_product_draft()
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  new_product uuid;
  draft_id    uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create products';
  end if;

  insert into products (name, slug, price_inr)
  values ('', gen_random_uuid()::text, 0)
  returning id into new_product;

  insert into product_versions
    (product_id, state, version, name, slug, price_inr, created_by)
  values
    (new_product, 'draft', 1, '', gen_random_uuid()::text, 0, auth.uid())
  returning id into draft_id;

  return draft_id;
end;
$fn$;

revoke execute on function public.create_product_draft() from public;
grant execute on function public.create_product_draft() to authenticated, service_role;

-- 3 & 4. THE TWO PUBLISH PATHS — carried by a trigger, not by a third column list.
--
-- publish_one (0018) and publish_all (0013) each hold their own explicit list
-- of product columns to copy. Adding to both is exactly how they drift: the
-- next person adds a column to one, the other keeps working, and nobody finds
-- out until a published product is missing a field.
--
-- THIS ALREADY HAPPENED. 0037 added hsn_code to products AND product_versions,
-- but neither publish path copies it — so an admin setting an HSN code on a
-- draft would publish it and products.hsn_code would stay null. Nobody would
-- have noticed until GST registration, at which point every product would
-- need re-entering.
--
-- So the columns those lists forget are synced by a trigger on the version
-- becoming published instead. Adding a column here means touching one place
-- that fires however the publish happened — one at a time, or all at once.
create or replace function public.sync_published_product_extras()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update products p
     set hsn_code       = new.hsn_code,
         cost_price_inr = new.cost_price_inr,
         -- A product drafted through the admin form has no SKU: create_product_draft
         -- deliberately leaves it null rather than deriving one from a placeholder
         -- slug. It gets one here, from the slug it actually shipped with.
         sku            = coalesce(new.sku, public.sku_from_slug(new.slug))
   where p.id = new.product_id;
  return new;
end;
$fn$;

drop trigger if exists sync_product_extras on product_versions;
create trigger sync_product_extras
  after update of state on product_versions
  for each row
  when (new.state = 'published' and old.state is distinct from 'published')
  execute function public.sync_published_product_extras();

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name in ('sku', 'cost_price_inr')) as product_columns,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'product_versions'
      and column_name in ('sku', 'cost_price_inr')) as version_columns,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('cogs_inr','courier_actual_cost_inr','gateway_fee_inr','gateway_tax_inr')) as order_columns,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'stock_movements') as movements_table,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('sku_from_slug','sync_published_product_extras')) as new_functions,
  (select count(*) from pg_trigger where tgname = 'sync_product_extras') as sync_trigger,
  (select count(*) from products where sku is null) as products_without_sku,
  (select count(*) from pg_indexes where indexname = 'products_sku_unique') as sku_index;

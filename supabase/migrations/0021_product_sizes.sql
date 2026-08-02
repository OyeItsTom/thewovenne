-- 0021 — Per-size stock
--
-- A product can now carry its own sizes, each with its own stock. Sizes are
-- per-product rather than a fixed global list: a kurta, a shirt and a dupatta
-- do not share a size run, and a global enum would be wrong within a month.
-- A product with no rows here (sarees, home) keeps the single stock count on
-- its version, exactly as before.
--
-- DELIBERATELY NOT VERSIONED, unlike every other product field.
--
-- Stock is operational, not editorial. A customer's purchase cannot go through
-- a draft/publish cycle, and a draft copy of stock diverges from reality the
-- moment anyone buys. So edits here take effect immediately. That is an
-- inconsistency with the rest of the admin and the UI says so, rather than
-- letting it surprise someone who expected Publish to gate it.

create table if not exists product_sizes (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  label          text not null,
  sort_order     integer not null default 0,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  created_at     timestamptz not null default now(),
  unique (product_id, label)
);

create index if not exists product_sizes_product_idx
  on product_sizes (product_id, sort_order);

alter table product_sizes enable row level security;

-- Public read: the storefront must show which sizes are sold out, and a sold
-- out size is not a secret.
do $$ begin
  create policy "Anyone can view sizes" on product_sizes for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Admins manage sizes" on product_sizes for all
    to authenticated using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

grant select on product_sizes to anon, authenticated;
grant insert, update, delete on product_sizes to authenticated;
grant all on product_sizes to service_role;

-- ── Take stock, atomically ────────────────────
-- The guard is `stock_quantity >= p_qty` inside the UPDATE itself. Two buyers
-- racing for the last unit both read 1, but only one UPDATE can hold the row
-- lock; the second re-evaluates against the decremented value and matches no
-- rows. A read-then-write in application code cannot do this — by the time the
-- application has decided there is stock, the fact may already be stale.
--
-- Raises rather than reporting per line, so a cart is all-or-nothing: reserving
-- half an order and charging for it is worse than refusing the whole thing.
create or replace function public.reserve_stock(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  item        jsonb;
  p_id        uuid;
  p_label     text;
  p_qty       integer;
  has_sizes   boolean;
  affected    integer;
  taken       integer := 0;
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
      -- No size rows: the single count on the published version, as before.
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

    taken := taken + p_qty;
  end loop;

  return jsonb_build_object('reserved', taken);
end;
$fn$;

revoke execute on function public.reserve_stock(jsonb) from public, anon, authenticated;
grant execute on function public.reserve_stock(jsonb) to service_role;

-- ── Give it back ──────────────────────────────
-- For a refund or a cancelled order. Separate from reserve_stock so returning
-- stock can never be mistaken for taking it.
create or replace function public.release_stock(p_items jsonb)
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
  for item in select * from jsonb_array_elements(p_items) loop
    p_id    := (item ->> 'id')::uuid;
    p_label := item ->> 'size';
    p_qty   := coalesce((item ->> 'quantity')::integer, 0);
    if p_qty <= 0 then continue; end if;

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

    given := given + p_qty;
  end loop;

  return jsonb_build_object('released', given);
end;
$fn$;

revoke execute on function public.release_stock(jsonb) from public, anon, authenticated;
grant execute on function public.release_stock(jsonb) to service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'product_sizes') as sizes_table,
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('reserve_stock', 'release_stock')) as stock_fns,
  (select count(*) from product_sizes) as size_rows;

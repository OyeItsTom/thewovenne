-- 0024 — Order lifecycle, shipping, and dispatch details
--
-- Orders had two usable states: payment_status pending|paid, and a
-- tracking_status that only ever held 'needs_review'. Nothing could mark an
-- order shipped, because nothing in the admin could see an order at all — a
-- paid order was invisible outside SQL.
--
-- Fulfilment status is kept SEPARATE from payment status. They answer different
-- questions ("has the money arrived?" vs "where is the parcel?") and conflating
-- them means a refunded-but-delivered order has nowhere to sit.

alter table orders
  add column if not exists status            text not null default 'placed',
  add column if not exists needs_review      boolean not null default false,
  add column if not exists shipping_cost_inr numeric(10,2) not null default 0,
  add column if not exists courier_name      text,
  add column if not exists awb_number        text,
  add column if not exists shipped_at        timestamptz,
  add column if not exists delivered_at      timestamptz,
  add column if not exists admin_note        text;

do $$ begin
  alter table orders add constraint orders_status_check
    check (status in ('placed', 'confirmed', 'shipped', 'delivered', 'cancelled'));
exception when duplicate_object then null; end $$;

create index if not exists orders_status_idx on orders (status, created_at desc);
create index if not exists orders_created_idx on orders (created_at desc);
create index if not exists orders_needs_review_idx on orders (needs_review) where needs_review;

-- ── Migrate the old flag ──────────────────────
-- needs_review lived in tracking_status, which also had to serve as free text.
-- A boolean is what it always was.
update orders set needs_review = true where tracking_status = 'needs_review';
update orders set status = 'confirmed'
 where payment_status = 'paid' and status = 'placed';

-- ── Shipping configuration ────────────────────
-- In site_content so the zone, rate and threshold are editable from the admin
-- without a deploy, like every other piece of configuration here.
--
-- Two tiers by PIN prefix rather than weight bands: weight-based pricing needs
-- a weight on every product and makes every quote a calculation that can be
-- wrong. This is a lookup, and it is right or obviously wrong.
insert into site_content (key, value, draft_value)
select
  'shipping',
  '{"free_pin_prefixes": ["67", "68", "69"],
    "flat_rate_inr": 120,
    "free_above_inr": 3000,
    "note": "Free delivery across Kerala, and on orders over the threshold."}'::jsonb,
  '{"free_pin_prefixes": ["67", "68", "69"],
    "flat_rate_inr": 120,
    "free_above_inr": 3000,
    "note": "Free delivery across Kerala, and on orders over the threshold."}'::jsonb
where not exists (select 1 from site_content where key = 'shipping');

-- ── Admins manage orders ──────────────────────
-- 0003 gave admins SELECT only, which was enough when nothing could be changed.
do $$ begin
  create policy "Admins update orders" on orders for update
    to authenticated using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

grant update on orders to authenticated;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_name = 'orders'
      and column_name in ('status','needs_review','shipping_cost_inr',
                          'courier_name','awb_number','shipped_at',
                          'delivered_at','admin_note')) as new_columns,
  (select count(*) from site_content where key = 'shipping') as shipping_config,
  (select count(*) from orders) as orders_total,
  (select count(*) from orders where needs_review) as flagged;

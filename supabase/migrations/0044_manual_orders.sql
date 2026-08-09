-- 0044 — Orders taken in person
--
-- A sale at a stall or over the phone is a real order: it earns revenue, costs
-- goods, moves stock and needs an invoice. The only thing it does not have is
-- a payment gateway, because the money already changed hands.
--
-- SO IT IS NOT SPECIAL-CASED ANYWHERE DOWNSTREAM. It lands in `orders` with
-- payment_status 'paid' like any other, and the P&L, the analytics and the
-- exports pick it up without knowing or caring how it was paid for. The single
-- exception is the one below, and it exists because the opposite would be a
-- false alarm.
--
-- THE FALSE ALARM THIS FIXES. 0041's P&L counts orders with no gateway fee as
-- INCOMPLETE DATA, on the correct assumption that a Razorpay order should
-- always have one. An offline order legitimately has none — so without this,
-- every in-person sale would appear under "This profit is overstated" as if
-- something were missing, and the warning that exists to be believed would
-- start crying wolf on perfectly good rows.

alter table orders
  add column if not exists payment_method text;

do $$ begin
  alter table orders add constraint orders_payment_method_check
    check (payment_method is null or payment_method in
      ('razorpay', 'cash', 'upi', 'card_offline', 'bank_transfer', 'other'));
exception when duplicate_object then null; end $$;

comment on column orders.payment_method is
  'How the money arrived. "razorpay" is online; everything else was taken in
   person and has no gateway fee by definition — see the P&L gap count.';

-- Everything that exists today came through Razorpay.
update orders
   set payment_method = 'razorpay'
 where payment_method is null
   and coalesce(payment_provider, 'razorpay') = 'razorpay';

create index if not exists orders_payment_method_idx on orders (payment_method);

-- ══ P&L: stop flagging offline orders ═════════
-- Only the gap count changes. Gateway fees themselves were already correct:
-- sum() ignores nulls, so an offline order has always contributed zero.
create or replace function public.profit_and_loss(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  rev            record;
  quality        record;
  expense_rows   jsonb;
  expense_total  numeric := 0;
  gross          numeric;
  operating      numeric;
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the profit and loss';
  end if;

  select
    coalesce(sum(o.total_inr), 0)                                as revenue_total,
    coalesce(sum(o.shipping_cost_inr), 0)                        as delivery_charged,
    coalesce(sum(o.total_inr - o.shipping_cost_inr), 0)          as goods_revenue,
    coalesce(sum(o.cogs_inr), 0)                                 as cogs,
    coalesce(sum(o.coupon_discount_inr), 0)                      as coupon_given,
    coalesce(sum(o.loyalty_discount_inr), 0)                     as loyalty_given,
    coalesce(sum(o.gateway_fee_inr), 0)                          as gateway_fee,
    coalesce(sum(o.gateway_tax_inr), 0)                          as gateway_tax,
    coalesce(sum(o.courier_actual_cost_inr), 0)                  as courier_cost,
    count(*)                                                     as order_count
    into rev
    from orders o
   where o.payment_status = 'paid'
     and o.status <> 'cancelled'
     and o.created_at >= p_from::timestamptz
     and o.created_at < (p_to + 1)::timestamptz;

  select
    count(*) filter (
      where exists (
        select 1 from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) i
         where (i ->> 'cost_price_inr') is null
      )
    ) as orders_uncosted,
    -- CHANGED IN 0044: only an ONLINE order missing its fee is a gap. An
    -- in-person sale has no gateway fee to be missing.
    count(*) filter (
      where o.gateway_fee_inr is null
        and coalesce(o.payment_method, 'razorpay') = 'razorpay'
    ) as orders_no_gateway_fee,
    count(*) filter (where o.courier_actual_cost_inr is null) as orders_no_courier_cost
    into quality
    from orders o
   where o.payment_status = 'paid'
     and o.status <> 'cancelled'
     and o.created_at >= p_from::timestamptz
     and o.created_at < (p_to + 1)::timestamptz;

  select coalesce(jsonb_agg(jsonb_build_object(
           'category', t.category,
           'amount', t.total_inr,
           'tax', t.tax_inr,
           'entries', t.entries
         ) order by t.total_inr desc), '[]'::jsonb),
         coalesce(sum(t.total_inr), 0)
    into expense_rows, expense_total
    from public.expense_totals(p_from, p_to) t;

  gross     := rev.revenue_total - rev.cogs;
  operating := rev.gateway_fee + rev.gateway_tax + rev.courier_cost + expense_total;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'revenue', jsonb_build_object(
      'goods', rev.goods_revenue,
      'delivery', rev.delivery_charged,
      'total', rev.revenue_total,
      'orders', rev.order_count
    ),
    'discounts_given', jsonb_build_object(
      'coupons', rev.coupon_given,
      'loyalty', rev.loyalty_given,
      'total', rev.coupon_given + rev.loyalty_given
    ),
    'cogs', rev.cogs,
    'gross_profit', gross,
    'gross_margin_pct', case when rev.revenue_total > 0
                             then round((gross / rev.revenue_total) * 100, 1)
                             else null end,
    'operating_costs', jsonb_build_object(
      'gateway_fee', rev.gateway_fee,
      'gateway_tax', rev.gateway_tax,
      'courier', rev.courier_cost,
      'expenses', expense_rows,
      'expenses_total', expense_total,
      'total', operating
    ),
    'net_profit', gross - operating,
    'net_margin_pct', case when rev.revenue_total > 0
                           then round(((gross - operating) / rev.revenue_total) * 100, 1)
                           else null end,
    'gaps', jsonb_build_object(
      'orders_with_uncosted_items', quality.orders_uncosted,
      'orders_without_gateway_fee', quality.orders_no_gateway_fee,
      'orders_without_courier_cost', quality.orders_no_courier_cost,
      'products_without_cost', (select count(*) from products where cost_price_inr is null)
    )
  );
end;
$fn$;

revoke execute on function public.profit_and_loss(date, date) from public, anon;
grant execute on function public.profit_and_loss(date, date) to authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'payment_method') as column_present,
  (select count(*) from pg_constraint
    where conname = 'orders_payment_method_check') as constraint_present,
  (select count(*) from orders where payment_method is null) as unbackfilled,
  (select count(*) from pg_indexes
    where indexname = 'orders_payment_method_idx') as index_present;

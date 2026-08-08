-- 0041 — Profit and loss
--
-- Reads what 0038 and 0040 capture. Nothing new is recorded here; this is the
-- arithmetic, and it lives in the database so the screen, the Excel export and
-- any later summary cannot each add the same numbers up differently. A P&L that
-- disagrees with its own export is worse than either on its own.
--
-- ── WHAT COUNTS AS REVENUE ────────────────────
--
-- PAID orders only, dated by when the order was placed, excluding cancelled
-- ones. total_inr is what Razorpay actually captured — already net of the
-- coupon and the loyalty points.
--
-- SO DISCOUNTS ARE NOT SUBTRACTED AGAIN. They are reported because "we gave
-- away ₹40,000 this quarter" is worth knowing, but they are already gone from
-- total_inr and taking them off a second time would understate revenue by
-- exactly the amount of every promotion ever run. This is the single easiest
-- way to get this report wrong.
--
-- ── WHAT THE NUMBERS CANNOT KNOW ──────────────
--
-- Three costs are captured per order and any of them can be missing:
--
--   cogs_inr                — zero for a line whose product was never costed
--   gateway_fee_inr         — null if Razorpay's API could not be read
--   courier_actual_cost_inr — null until a courier export is imported
--
-- A missing cost does not lower profit, so EVERY ONE OF THESE MAKES THE SHOP
-- LOOK MORE PROFITABLE THAN IT IS. That is the dangerous direction, so the
-- function counts them and returns the counts alongside the money. A report
-- that quietly flatters you is worse than no report.

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

  -- Both bounds inclusive: a financial year runs 1 April to 31 March and both
  -- of those days belong to it. created_at is a timestamp, so the upper bound
  -- has to reach the end of that day rather than its midnight.
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

  -- How much of the above is not to be trusted, and why.
  select
    count(*) filter (
      where exists (
        select 1 from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) i
         where (i ->> 'cost_price_inr') is null
      )
    ) as orders_uncosted,
    count(*) filter (where o.gateway_fee_inr is null)         as orders_no_gateway_fee,
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
    -- Reported, NOT subtracted — already out of total_inr. See the header.
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
    -- Every one of these makes the shop look MORE profitable than it is.
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
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'profit_and_loss') as function_present,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'profit_and_loss' and grantee = 'authenticated') as admin_can_call;

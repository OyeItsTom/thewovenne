-- 0045 — Cancelling an order
--
-- One function, because a cancellation is four things that must all happen or
-- none: a credit note issued, stock put back, the order marked cancelled, and
-- the moment recorded. Done from the application in four calls, a failure
-- between any two leaves an order that is cancelled but not credited, or
-- credited but still counted.
--
-- ── THE STOCK TRAP ────────────────────────────
--
-- The obvious implementation calls release_stock and moves on. That INVENTS
-- INVENTORY for any order where the stock never came out in the first place.
--
-- The Razorpay route flags an order needs_review when reserve_stock fails —
-- two buyers racing for the last piece, both paying, one of them leaving the
-- count short. Those orders are PAID but their stock was never decremented.
-- Putting it back on cancellation would add a piece to the shelf that was
-- never there, and the counts would drift upward every time such an order was
-- cancelled — silently, and in the direction that causes overselling.
--
-- So stock is returned only when it was actually taken, which the movement log
-- from 0038 can answer directly: a 'sale' movement exists for this order, or
-- it does not.
--
-- ── WHY THE P&L CHANGES SHAPE ─────────────────
--
-- 0041 excluded cancelled orders entirely, which removed their revenue from
-- the period they were SOLD in. A month closed in April could therefore change
-- in June, which is exactly what credit notes exist to prevent.
--
-- Revenue now includes every paid order in the period, cancelled or not,
-- because the sale genuinely happened then. Credit notes are subtracted in the
-- period they were ISSUED. A cancellation is an event with its own date, not a
-- retroactive edit of an earlier one.

create or replace function public.cancel_order(
  p_order_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target      orders%rowtype;
  stock_taken boolean;
  note        jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can cancel an order';
  end if;

  select * into target from orders where id = p_order_id for update;
  if not found then
    raise exception 'No such order';
  end if;
  if target.status = 'cancelled' then
    raise exception 'That order is already cancelled';
  end if;
  if target.payment_status <> 'paid' then
    raise exception 'That order was never paid, so there is nothing to cancel';
  end if;

  -- See THE STOCK TRAP above. A sale movement is the only reliable evidence
  -- that stock actually left, because needs_review can be cleared by hand.
  select exists (
    select 1 from stock_movements
     where order_id = p_order_id and reason = 'sale'
  ) into stock_taken;

  if stock_taken then
    perform public.release_stock(
      target.items,
      p_order_id,
      'cancellation'
    );
  end if;

  note := public.issue_credit_note(
    p_order_id,
    'cancellation',
    target.total_inr,
    coalesce(p_reason, 'Order cancelled'),
    target.items
  );

  update orders
     set status = 'cancelled',
         cancelled_at = now()
   where id = p_order_id;

  return jsonb_build_object(
    'credit_note', note,
    'stock_returned', stock_taken,
    -- Said out loud so the admin is told rather than left to notice. An order
    -- whose stock never came out is unusual and worth a second look.
    'stock_note', case when stock_taken
      then null
      else 'No stock was returned: this order never decremented stock, so putting it back would have created inventory that never existed.'
    end
  );
end;
$fn$;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated, service_role;

-- ══ P&L: cancellations land in their own period ══
create or replace function public.profit_and_loss(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  rev            record;
  credits        record;
  quality        record;
  expense_rows   jsonb;
  expense_total  numeric := 0;
  gross          numeric;
  operating      numeric;
  net_revenue    numeric;
  net_cogs       numeric;
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the profit and loss';
  end if;

  -- CHANGED IN 0045: no `status <> cancelled`. A sale that happened in this
  -- period belongs to this period, whatever became of it later.
  select
    coalesce(sum(o.total_inr), 0)                       as revenue_total,
    coalesce(sum(o.shipping_cost_inr), 0)               as delivery_charged,
    coalesce(sum(o.total_inr - o.shipping_cost_inr), 0) as goods_revenue,
    coalesce(sum(o.cogs_inr), 0)                        as cogs,
    coalesce(sum(o.coupon_discount_inr), 0)             as coupon_given,
    coalesce(sum(o.loyalty_discount_inr), 0)            as loyalty_given,
    coalesce(sum(o.gateway_fee_inr), 0)                 as gateway_fee,
    coalesce(sum(o.gateway_tax_inr), 0)                 as gateway_tax,
    coalesce(sum(o.courier_actual_cost_inr), 0)         as courier_cost,
    count(*)                                            as order_count
    into rev
    from orders o
   where o.payment_status = 'paid'
     and o.created_at >= p_from::timestamptz
     and o.created_at < (p_to + 1)::timestamptz;

  -- Credits are dated by when they were ISSUED, which is the whole point.
  --
  -- The COGS reversal is PROPORTIONAL to how much of the order was credited.
  -- For a full cancellation that is the whole thing. For a partial return it
  -- is an approximation — the exact cost of the returned lines is knowable
  -- from credit_notes.items, and when partial returns exist this should read
  -- from there instead. Said plainly rather than left as a silent rounding.
  select
    coalesce(sum(cn.amount_inr), 0) as credited,
    coalesce(sum(
      case when o.total_inr > 0
        then o.cogs_inr * (cn.amount_inr / o.total_inr)
        else 0 end
    ), 0) as cogs_reversed,
    count(*) as note_count
    into credits
    from credit_notes cn
    left join orders o on o.id = cn.order_id
   where cn.issued_at >= p_from::timestamptz
     and cn.issued_at < (p_to + 1)::timestamptz;

  select
    count(*) filter (
      where exists (
        select 1 from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) i
         where (i ->> 'cost_price_inr') is null
      )
    ) as orders_uncosted,
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
           'category', t.category, 'amount', t.total_inr,
           'tax', t.tax_inr, 'entries', t.entries
         ) order by t.total_inr desc), '[]'::jsonb),
         coalesce(sum(t.total_inr), 0)
    into expense_rows, expense_total
    from public.expense_totals(p_from, p_to) t;

  net_revenue := rev.revenue_total - credits.credited;
  net_cogs    := rev.cogs - credits.cogs_reversed;
  gross       := net_revenue - net_cogs;
  operating   := rev.gateway_fee + rev.gateway_tax + rev.courier_cost + expense_total;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'revenue', jsonb_build_object(
      'goods', rev.goods_revenue,
      'delivery', rev.delivery_charged,
      'gross_total', rev.revenue_total,
      'total', net_revenue,
      'orders', rev.order_count
    ),
    'credits', jsonb_build_object(
      'amount', credits.credited,
      'cogs_reversed', credits.cogs_reversed,
      'notes', credits.note_count
    ),
    'discounts_given', jsonb_build_object(
      'coupons', rev.coupon_given,
      'loyalty', rev.loyalty_given,
      'total', rev.coupon_given + rev.loyalty_given
    ),
    'cogs', net_cogs,
    'gross_profit', gross,
    'gross_margin_pct', case when net_revenue > 0
                             then round((gross / net_revenue) * 100, 1) else null end,
    'operating_costs', jsonb_build_object(
      'gateway_fee', rev.gateway_fee,
      'gateway_tax', rev.gateway_tax,
      'courier', rev.courier_cost,
      'expenses', expense_rows,
      'expenses_total', expense_total,
      'total', operating
    ),
    'net_profit', gross - operating,
    'net_margin_pct', case when net_revenue > 0
                           then round(((gross - operating) / net_revenue) * 100, 1) else null end,
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
    and proname = 'cancel_order') as cancel_function,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'profit_and_loss') as pl_function,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'cancel_order' and grantee = 'authenticated') as admin_can_cancel;

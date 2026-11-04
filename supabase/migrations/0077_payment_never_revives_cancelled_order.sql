-- 0077 — A payment never revives a cancelled order (WP-ORDER-SAFETY-02, OS-1)
--
-- THE DEFECT (WP-ORDER-SAFETY-01, D5 and D6, demonstrated on a PG 17.6 replay).
-- An unpaid order can be cancelled from the admin while its Razorpay order is
-- still payable. When the payment is captured afterwards, settlement (lib/
-- settleOrder) never looked at orders.status. It took the stock, marked the
-- order paid, assigned an invoice number and claimed the confirmation email —
-- for an order that stays "cancelled". cancel_order then refused ("already
-- cancelled"), so no credit note or refund could follow: the customer was
-- charged and told "confirmed" for an order nobody would send. A settlement
-- RETRY after a cancellation could likewise take stock for the cancelled order.
--
-- ROOT CAUSE. Settlement was several separate calls (separate transactions),
-- none of which asked whether the order was still open. A check added to one
-- of them would leave a window between them; the decision has to be made once,
-- under the order's row lock, in one transaction.
--
-- WHAT THIS DOES.
--
--   1. orders.razorpay_payment_id — the payment that settled the order, so a
--      replay of the same payment and a SECOND payment can be told apart.
--      Nullable: orders settled before this have none, and a replay fills it.
--
--   2. payment_refund_obligations — one row per captured payment that we will
--      not fulfil and therefore owe back in full. Holds the provider evidence
--      (ids, amount, currency, fee, tax, Razorpay's status) and when we saw it.
--      Its only state is 'owed': nothing here can say a refund was made,
--      because nothing here makes or verifies one (that is OS-3). No personal
--      data, so an order's anonymisation (0033) leaves it intact.
--
--   3. settle_razorpay_payment() — the one place a captured Razorpay payment
--      is applied to an order, service_role only. Locks the order FOR UPDATE,
--      then either
--        • records a refund owed (order cancelled before this payment, or a
--          second payment for an already-paid order): flags the order, and
--          changes nothing else — status, payment_status, stock, invoice and
--          confirmation all stay as they were; or
--        • settles normally, as lib/settleOrder did before: reserve_stock
--          from the stored lines, mark paid with the captured amount, fee,
--          tax and payment id, and assign the invoice number — all in one
--          transaction.
--      A payment already recorded as owed always takes the owed path, so
--      re-opening the order by hand cannot turn a refund owed into a sale.
--
--   4. reserve_stock refuses a cancelled order (ORDER_CANCELLED). Every caller,
--      not only settlement: the guard is at the shared boundary.
--
--   5. orders_cancelled_order_guard — a cancelled order cannot be marked paid,
--      be given an invoice number, or have its order confirmation claimed, by
--      any path: old application code during a deploy window, the admin's
--      table UPDATE, 0074's enqueue. A paid order cancelled through
--      cancel_order keeps everything it already had.
--
-- WHAT IT DOES NOT DO (later work packages): refund anything, record refunds,
-- reverse loyalty or coupons, restrict admin UPDATE on orders (OS-2), or
-- change cancel_order.
--
-- ROLLBACK. See reports/order-safety/wp-order-safety-02-*/ROLLBACK-0077.sql:
-- guarded, refuses while any obligation row exists (that row is the only
-- record of money owed). Fix-forward is preferred.

-- ── Preflight ──────────────────────────────────
do $$
begin
  if to_regprocedure('public.reserve_stock(jsonb, uuid)') is null then
    raise exception '0077: reserve_stock(jsonb, uuid) does not exist';
  end if;
  if to_regprocedure('public.assign_invoice_number(uuid)') is null then
    raise exception '0077: assign_invoice_number(uuid) does not exist';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception '0077: is_admin() does not exist';
  end if;
  if to_regclass('public.payment_refund_obligations') is not null
     or to_regprocedure('public.settle_razorpay_payment(text, text, bigint, text, bigint, bigint, text)') is not null then
    raise exception '0077: already applied; refusing to replace it';
  end if;
end $$;

-- ══ 1. The settling payment, on the order ══
-- IF NOT EXISTS: the rollback keeps this column (it is evidence), so 0077 must
-- be able to apply again over it.
alter table public.orders add column if not exists razorpay_payment_id text;

comment on column public.orders.razorpay_payment_id is
  'The Razorpay payment that settled this order (0077). Null for orders settled
   before 0077 until a replay fills it, and for orders not paid through Razorpay.';

-- A payment settles one order. Partial: every historical row is null.
create unique index if not exists orders_razorpay_payment_id_key
  on public.orders (razorpay_payment_id)
  where razorpay_payment_id is not null;

-- ══ 2. Refunds owed ══
create table public.payment_refund_obligations (
  id                     uuid primary key default gen_random_uuid(),
  -- Set null, never cascade: the money is owed whatever happens to the order.
  order_id               uuid references public.orders(id) on delete set null,
  provider               text not null default 'razorpay' check (provider = 'razorpay'),
  razorpay_order_id      text not null,
  -- One obligation per payment: the idempotency key for every repeat.
  razorpay_payment_id    text not null unique,
  amount_paise           bigint not null check (amount_paise > 0),
  currency               text not null check (currency = 'INR'),
  gateway_fee_paise      bigint,
  gateway_tax_paise      bigint,
  -- What Razorpay's API said when we fetched the payment. Always 'captured'
  -- today: nothing else reaches settlement.
  provider_status        text not null,
  reason                 text not null
                         check (reason in ('captured_after_cancellation', 'second_payment')),
  -- The order as it stood when the payment arrived — the evidence for why it
  -- was not fulfilled.
  order_status_at_capture         text not null,
  order_payment_status_at_capture text not null,
  -- 'owed' only. Recording that a refund was made, and with what provider
  -- evidence, is OS-3; until then nothing can claim it.
  state                  text not null default 'owed' check (state in ('owed')),
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  times_seen             integer not null default 1 check (times_seen >= 1)
);

comment on table public.payment_refund_obligations is
  'A captured payment that will not be fulfilled and is owed back in full (0077).
   Written only by settle_razorpay_payment. Its only state is owed: no row here
   says a refund was made.';

create index payment_refund_obligations_order_idx on public.payment_refund_obligations (order_id);
create index payment_refund_obligations_open_idx
  on public.payment_refund_obligations (first_seen_at) where state = 'owed';

alter table public.payment_refund_obligations enable row level security;

create policy "Admins read refund obligations" on public.payment_refund_obligations
  for select to authenticated using (public.is_admin());

-- Read-only to everyone but the function's owner. Explicit, not inherited from
-- default privileges (see WP-01A: replay masks missing service_role grants).
revoke all on table public.payment_refund_obligations from public, anon, authenticated, service_role;
grant select on table public.payment_refund_obligations to authenticated, service_role;

-- ══ 3. reserve_stock: same as 0060, refuses a cancelled order ══
create or replace function public.reserve_stock(p_items jsonb, p_order_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  line      record;
  affected  integer;
  taken     integer := 0;
  skipped   integer := 0;
  conflict  text;
  v_status  text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'reserve_stock expects a JSON array of lines';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) x
     where coalesce((x ->> 'quantity')::integer, 0) <= 0
  ) then
    raise exception 'Invalid quantity for product %', (
      select x ->> 'id' from jsonb_array_elements(p_items) x
       where coalesce((x ->> 'quantity')::integer, 0) <= 0
       limit 1
    );
  end if;

  -- Lock order (1): the order — and, since 0077, its status. Stock never
  -- comes out for a cancelled order, whoever asks.
  if p_order_id is not null then
    select status into v_status from orders where id = p_order_id for key share;
    if v_status = 'cancelled' then
      raise exception 'ORDER_CANCELLED:%', p_order_id using errcode = '55000';
    end if;
  end if;

  -- Lock order (2): every product in the order, by id.
  perform 1 from products
   where id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x)
   order by id
   for no key update;

  for line in
    select e.product_id,
           s.has_sizes,
           case when s.has_sizes then e.label end as size_label,
           sum(e.qty)::integer as qty
      from (
        select (x ->> 'id')::uuid                   as product_id,
               nullif(btrim(x ->> 'size'), '')      as label,
               (x ->> 'quantity')::integer          as qty
          from jsonb_array_elements(p_items) x
      ) e
      cross join lateral (
        select exists (
          select 1 from product_sizes ps where ps.product_id = e.product_id
        ) as has_sizes
      ) s
     group by e.product_id, s.has_sizes, case when s.has_sizes then e.label end
     order by e.product_id, case when s.has_sizes then e.label end
  loop
    if line.has_sizes and line.size_label is null then
      raise exception 'SIZE_REQUIRED:%', line.product_id;
    end if;

    begin
      insert into stock_movements (product_id, size_label, delta, reason, order_id)
      values (line.product_id, line.size_label, -line.qty, 'sale', p_order_id);
    exception when unique_violation then
      get stacked diagnostics conflict = constraint_name;
      if conflict is distinct from 'stock_movements_one_sale_per_line' then
        raise;
      end if;
      skipped := skipped + line.qty;
      continue;
    end;

    if line.has_sizes then
      update product_sizes
         set stock_quantity = stock_quantity - line.qty
       where product_id = line.product_id
         and label = line.size_label
         and stock_quantity >= line.qty;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'SOLD_OUT:%:%', line.product_id, line.size_label;
      end if;
    else
      update product_versions
         set stock_quantity = stock_quantity - line.qty
       where product_id = line.product_id
         and state = 'published'
         and stock_quantity >= line.qty;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'SOLD_OUT:%:', line.product_id;
      end if;
    end if;

    taken := taken + line.qty;
  end loop;

  return jsonb_build_object('reserved', taken, 'already_reserved', skipped);
end;
$fn$;

revoke execute on function public.reserve_stock(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.reserve_stock(jsonb, uuid) to service_role;

-- ══ 4. A cancelled order stays unfulfilled ══
create function public.orders_cancelled_order_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.status = 'cancelled' then
    if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
      raise exception 'A cancelled order cannot be marked paid. A payment captured after cancellation is recorded as a refund owed (settle_razorpay_payment, 0077).'
        using errcode = '55000';
    end if;
    if new.invoice_number is not null and old.invoice_number is null then
      raise exception 'A cancelled order is not issued an invoice.'
        using errcode = '55000';
    end if;
    if new.confirmation_sent_at is not null and old.confirmation_sent_at is null then
      raise exception 'A cancelled order is not sent an order confirmation.'
        using errcode = '55000';
    end if;
  end if;
  return new;
end
$fn$;

revoke execute on function public.orders_cancelled_order_guard() from public, anon, authenticated;

create trigger orders_cancelled_order_guard
  before update of status, payment_status, invoice_number, confirmation_sent_at on public.orders
  for each row execute function public.orders_cancelled_order_guard();

-- ══ 5. Applying a captured payment ══
create function public.settle_razorpay_payment(
  p_razorpay_order_id   text,
  p_razorpay_payment_id text,
  p_amount_paise        bigint,
  p_currency            text,
  p_fee_paise           bigint default null,
  p_tax_paise           bigint default null,
  p_provider_status     text default 'captured'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  o              orders%rowtype;
  v_reason       text;
  v_lines        jsonb;
  v_has_lines    boolean;
  v_reserved     jsonb;
  v_stock        text := 'none';
  v_stock_error  text;
  v_invoice      text;
  v_invoice_error text;
  v_flag         boolean;
  v_obligation   uuid;
  v_first        boolean;
begin
  -- Fail closed on evidence that is missing or is not a capture. The caller
  -- (lib/settleOrder) has already fetched the payment from Razorpay; this is
  -- the database refusing to be told anything weaker.
  if coalesce(btrim(p_razorpay_order_id), '') = '' or coalesce(btrim(p_razorpay_payment_id), '') = '' then
    raise exception 'settle_razorpay_payment: the Razorpay order and payment ids are required'
      using errcode = '22023';
  end if;
  if p_provider_status is distinct from 'captured' then
    raise exception 'settle_razorpay_payment: only a captured payment is applied (got %)', coalesce(p_provider_status, 'none')
      using errcode = '22023';
  end if;
  if p_currency is distinct from 'INR' then
    raise exception 'settle_razorpay_payment: only INR is applied (got %)', coalesce(p_currency, 'none')
      using errcode = '22023';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 then
    raise exception 'settle_razorpay_payment: the captured amount must be positive'
      using errcode = '22023';
  end if;

  -- THE LOCK. Every other writer of this row — cancel_order, the admin's
  -- status UPDATE, another settlement — waits here or has already finished.
  select * into o from orders where razorpay_order_id = p_razorpay_order_id for update;
  if not found then
    return jsonb_build_object('path', 'no_order');
  end if;

  if o.total_inr is not null and round(o.total_inr * 100)::bigint <> p_amount_paise then
    return jsonb_build_object('path', 'mismatch', 'order_id', o.id);
  end if;

  -- Which path. A payment already recorded as owed stays owed, whatever the
  -- order looks like now.
  select reason into v_reason
    from payment_refund_obligations
   where razorpay_payment_id = p_razorpay_payment_id;

  if v_reason is null then
    if o.status = 'cancelled' then
      if o.payment_status = 'paid'
         and (o.razorpay_payment_id is null or o.razorpay_payment_id = p_razorpay_payment_id) then
        -- Paid while open, cancelled afterwards through cancel_order (credit
        -- note issued). A replay of that payment is old news. An order settled
        -- before 0077 has no payment id and is given the benefit of the doubt.
        return jsonb_build_object('path', 'already_settled_cancelled', 'order_id', o.id);
      end if;
      v_reason := case when o.payment_status = 'paid' then 'second_payment'
                       else 'captured_after_cancellation' end;
    elsif o.payment_status = 'paid'
          and o.razorpay_payment_id is not null
          and o.razorpay_payment_id <> p_razorpay_payment_id then
      v_reason := 'second_payment';
    end if;
  end if;

  -- ── Refund owed: record the evidence, flag, touch nothing else ──
  if v_reason is not null then
    insert into payment_refund_obligations as ob
      (order_id, razorpay_order_id, razorpay_payment_id, amount_paise, currency,
       gateway_fee_paise, gateway_tax_paise, provider_status, reason,
       order_status_at_capture, order_payment_status_at_capture)
    values
      (o.id, p_razorpay_order_id, p_razorpay_payment_id, p_amount_paise, p_currency,
       p_fee_paise, p_tax_paise, p_provider_status, v_reason,
       o.status, o.payment_status)
    on conflict (razorpay_payment_id) do update
      set last_seen_at = now(),
          times_seen   = ob.times_seen + 1
    returning ob.id, (ob.xmax = 0) into v_obligation, v_first;

    update orders set needs_review = true where id = o.id and not needs_review;

    return jsonb_build_object(
      'path', 'refund_owed',
      'reason', v_reason,
      'order_id', o.id,
      'obligation_id', v_obligation,
      'first', v_first
    );
  end if;

  -- ── Normal settlement: stock, paid, invoice — one transaction ──
  v_lines := case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end;
  v_has_lines := jsonb_array_length(v_lines) > 0;

  if v_has_lines then
    begin
      v_reserved := public.reserve_stock(
        (select jsonb_agg(jsonb_build_object('id', x -> 'id', 'size', x -> 'size', 'quantity', x -> 'quantity'))
           from jsonb_array_elements(v_lines) x),
        o.id
      );
      v_stock := case when coalesce((v_reserved ->> 'reserved')::integer, 0) > 0
                      then 'reserved' else 'already_reserved' end;
    exception when others then
      -- The customer has paid: a refusal (sold out, unknown size) flags the
      -- order rather than refusing the payment. The subtransaction rolled back
      -- any partial claim.
      v_stock := 'failed';
      v_stock_error := sqlerrm;
    end;
  end if;

  v_flag := v_stock in ('failed', 'none');

  update orders
     set payment_status      = 'paid',
         total_inr           = p_amount_paise / 100.0,
         gateway_fee_inr     = case when p_fee_paise is null then null else p_fee_paise / 100.0 end,
         gateway_tax_inr     = case when p_tax_paise is null then null else p_tax_paise / 100.0 end,
         razorpay_payment_id = coalesce(razorpay_payment_id, p_razorpay_payment_id),
         needs_review        = needs_review or v_flag
   where id = o.id;

  if v_has_lines then
    begin
      v_invoice := public.assign_invoice_number(o.id);
    exception when others then
      v_invoice_error := sqlerrm;
    end;
  end if;

  return jsonb_build_object(
    'path', 'settled',
    'order_id', o.id,
    'stock', v_stock,
    'stock_error', v_stock_error,
    'flagged', v_flag,
    'invoice_number', v_invoice,
    'invoice_error', v_invoice_error
  );
end
$fn$;

revoke execute on function public.settle_razorpay_payment(text, text, bigint, text, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.settle_razorpay_payment(text, text, bigint, text, bigint, bigint, text)
  to service_role;

comment on function public.settle_razorpay_payment(text, text, bigint, text, bigint, bigint, text) is
  'Applies a captured Razorpay payment to its order under the order row lock (0077):
   settles an open order (stock, paid, invoice) or records a refund owed for a
   cancelled order or a second payment. Never revives a cancelled order.';

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'razorpay_payment_id') as payment_id_column,
  (select count(*) from pg_trigger where tgname = 'orders_cancelled_order_guard' and not tgisinternal) as guard_trigger,
  (select count(*) from pg_proc where proname = 'settle_razorpay_payment') as settle_function,
  (select relrowsecurity from pg_class where oid = 'public.payment_refund_obligations'::regclass) as obligations_rls;

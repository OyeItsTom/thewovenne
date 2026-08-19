-- 0058 — Settling a payment twice must change nothing the second time
--
-- Two ways in, one set of effects. Until now there was exactly one path that
-- marked an order paid: a fetch fired from the customer's browser after the
-- Razorpay modal closed. If that fetch never landed — the phone slept during a
-- UPI app-switch, the network dropped, the tab was closed — the money had moved
-- and the database never heard about it. The fix is a webhook, which Razorpay
-- delivers with AT-LEAST-ONCE semantics and retries with exponential backoff for
-- 24 hours.
--
-- That fix is only safe if settling twice is harmless, and today it is not:
-- reserve_stock decrements every time it is called. Adding the webhook first
-- would have doubled the stock movement on every single order. So the ordering
-- matters — this migration lands before that route exists.
--
-- THE PATTERN IS NOT NEW HERE. 0029 already guards loyalty awards with a partial
-- unique index, and its comment says exactly why: "a retried webhook or a
-- double-clicked verify must not pay out twice, and a partial unique index is a
-- stronger guarantee than remembering to check." That reasoning was right. It
-- was simply never extended to stock — or, as it turns out, to the redemption
-- half of loyalty.
--
-- WHY INDEXES RATHER THAN `if already_settled then return`. A check-then-act in
-- application code has a window between the check and the act, and two settlement
-- paths arriving together is precisely the case this exists to survive. A unique
-- index has no window: the second writer loses, in the database, under
-- concurrency, whatever the application believes.

-- ══ 0. Pre-flight ══
--
-- Both indexes below are unique, so either will fail on data that already
-- violates them — and the bug they close is precisely one that CREATES such
-- data. If a settlement was ever replayed before today, the duplicate rows are
-- sitting in the table right now and this migration will not apply.
--
-- Postgres' own error for that is "could not create unique index ... Key
-- (order_id, product_id, coalesce) = (...) is duplicated", which says what
-- collided but not what to do about it. This says both, and refuses before
-- anything has been changed rather than half way through.
--
-- IF THIS RAISES: the duplicates are real stock movements that double-counted a
-- sale. Decide per row whether the stock was actually taken twice (correct it
-- with a 'correction' movement and delete the surplus 'sale' row) or whether
-- only the record duplicated (delete the surplus row). Do not widen the index to
-- make the error go away — it is reporting the bug, not causing it.
do $$
declare
  dup_sales      integer;
  dup_redemptions integer;
begin
  select count(*) into dup_sales from (
    select order_id, product_id, coalesce(size_label, '') as lbl
      from stock_movements
     where reason = 'sale' and order_id is not null
     group by 1, 2, 3 having count(*) > 1
  ) d;

  select count(*) into dup_redemptions from (
    select order_id from loyalty_ledger
     where points < 0 and order_id is not null
     group by 1 having count(*) > 1
  ) d;

  if dup_sales > 0 or dup_redemptions > 0 then
    raise exception
      'Cannot apply 0058: % duplicated sale line(s) and % duplicated redemption(s) already exist. '
      'These are the double-settlements this migration exists to prevent. Resolve them first — '
      'see the comment above this block.', dup_sales, dup_redemptions;
  end if;
end $$;

-- ══ 1. One sale movement per line, per order ══
--
-- Keyed on the line rather than the order, because an order has one movement per
-- product+size and all of them are legitimate. The cart merges by (id, size)
-- before it ever reaches here, so a single order cannot contain the same
-- product+size twice — which is what makes this key safe to treat as the
-- identity of a line.
--
-- coalesce(), because size_label is null for an unsized product and two nulls do
-- not conflict in a Postgres unique index. Without it, exactly the products with
-- no sizes would keep the bug.
--
-- Partial on reason = 'sale': a return, cancellation or correction against the
-- same order is a different, deliberate act and must stay possible. 0045's
-- cancellation path writes those, and this must not block it.
create unique index if not exists stock_movements_one_sale_per_line
  on stock_movements (order_id, product_id, coalesce(size_label, ''))
  where reason = 'sale' and order_id is not null;

-- ══ 2. One redemption per order ══
--
-- The gap 0029 left. award_loyalty_points has had
-- loyalty_ledger_one_award_per_order since the beginning; the redeem side has an
-- advisory lock and a balance check, which serialise two DIFFERENT checkouts by
-- the same customer but do nothing about the SAME order settled twice. A replay
-- would simply spend the points again, and the balance check would happily allow
-- it whenever the customer had enough left.
create unique index if not exists loyalty_ledger_one_redemption_per_order
  on loyalty_ledger (order_id) where points < 0 and order_id is not null;

-- ══ 3. One confirmation email per order ══
--
-- Not an index but the same idea: a column that can only be claimed once. The
-- sender does an UPDATE ... WHERE confirmation_sent_at IS NULL RETURNING id, so
-- whichever settlement path gets there first wins the row and sends, and the
-- other gets nothing back and stays quiet. Compare-and-set, not check-then-act.
alter table orders
  add column if not exists confirmation_sent_at timestamptz;

comment on column orders.confirmation_sent_at is
  'When the confirmation email was sent. Claimed atomically by whichever
   settlement path (browser verification or Razorpay webhook) arrives first, so
   the customer is emailed once even though both paths run.';

-- ══ 4. Webhook events already seen ══
--
-- Razorpay documents at-least-once delivery and gives every event a unique
-- x-razorpay-event-id for exactly this purpose. Recording the id before doing
-- the work means a duplicate delivery is recognised as a duplicate even if the
-- first attempt is still in flight — the primary key does the arbitration.
--
-- Kept deliberately thin: an id, a type and a timestamp. This is a dedupe
-- record, not an audit log of payment data, so nothing from the payload is
-- stored here.
create table if not exists razorpay_webhook_events (
  event_id    text primary key,
  event_type  text,
  received_at timestamptz not null default now()
);

comment on table razorpay_webhook_events is
  'Razorpay x-razorpay-event-id values already processed. Razorpay retries with
   exponential backoff for 24 hours and delivers at least once, so the same event
   will arrive again; inserting the id is what makes the second arrival a no-op.';

-- Applied over a direct connection by scripts/run-migration.mjs, never read
-- through PostgREST. Same posture as schema_migrations in 0057: RLS on, no
-- policy, no grants, so a leaked anon key cannot enumerate payment activity.
alter table razorpay_webhook_events enable row level security;

-- ══ 5. reserve_stock, now idempotent ══
--
-- One behavioural change: the movement row is inserted BEFORE the stock is
-- decremented, and a unique violation on that insert means this line has already
-- been settled — so the line is skipped entirely and nothing moves. Writing the
-- movement first is what makes it the lock rather than the receipt.
--
-- The guard is per line, not per call, so a settlement that somehow half-completed
-- finishes correctly rather than being skipped wholesale.
--
-- SOLD_OUT still aborts everything. The exception propagates out of the function,
-- and because the whole call is one statement in one transaction, every movement
-- and every decrement already made in this call rolls back with it. An order is
-- reserved completely or not at all.
--
-- WITHOUT p_order_id THERE IS NO IDEMPOTENCY, and there cannot be — the index has
-- nothing to key on. The signature keeps its default so 0045 and any other
-- existing caller still compiles, but the payment path now always passes one.
create or replace function public.reserve_stock(p_items jsonb, p_order_id uuid default null)
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
  skipped     integer := 0;
begin
  for item in select * from jsonb_array_elements(p_items) loop
    p_id    := (item ->> 'id')::uuid;
    p_label := item ->> 'size';
    p_qty   := coalesce((item ->> 'quantity')::integer, 0);

    if p_qty <= 0 then
      raise exception 'Invalid quantity for product %', p_id;
    end if;

    -- The claim on this line. If it is already taken this settlement is a
    -- repeat, and the stock below must not move again.
    begin
      insert into stock_movements (product_id, size_label, delta, reason, order_id)
      values (p_id, p_label, -p_qty, 'sale', p_order_id);
    exception when unique_violation then
      skipped := skipped + 1;
      continue;
    end;

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

    taken := taken + p_qty;
  end loop;

  -- `skipped` is what tells a caller this was a repeat rather than a first run.
  return jsonb_build_object('reserved', taken, 'already_reserved', skipped);
end;
$fn$;

revoke execute on function public.reserve_stock(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.reserve_stock(jsonb, uuid) to service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*)::int from pg_indexes
     where indexname = 'stock_movements_one_sale_per_line') as sale_index,
  (select count(*)::int from pg_indexes
     where indexname = 'loyalty_ledger_one_redemption_per_order') as redemption_index,
  (select count(*)::int from information_schema.columns
     where table_name = 'orders' and column_name = 'confirmation_sent_at') as confirmation_column,
  (select to_regclass('public.razorpay_webhook_events') is not null) as webhook_table,
  (select relrowsecurity from pg_class
     where oid = 'razorpay_webhook_events'::regclass) as webhook_rls_on,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'reserve_stock') as reserve_stock_overloads;
